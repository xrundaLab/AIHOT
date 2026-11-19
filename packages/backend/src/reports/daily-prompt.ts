import { createHash } from "node:crypto";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { promptFromText, rawPrompt } from "../editorial/prompts.ts";

const key = "prompts.daily-review";
const name = "daily-review";
type Revision = { text: string; at: string | null };
type State = { current: Revision; history: Revision[] };

export async function dailyPrompt(): Promise<State> {
  const [row] = await sql<{ value: State }[]>`SELECT value FROM settings WHERE key=${key}`;
  return row?.value ?? { current: { text: rawPrompt(name), at: null }, history: [] };
}

export async function dailyPromptForRun() {
  const { current } = await dailyPrompt();
  const system = promptFromText(name, current.text);
  const version = `${name}@${createHash("sha256").update(system).digest("hex").slice(0, 10)}`;
  return { system, version };
}

export async function publishDailyPrompt(text: unknown, expected: unknown, actor: string) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024 ||
      !/\{\{siteName\s*\}\}/.test(text) || !/\{\{>\s*family-context\s*\}\}/.test(text) ||
      [...text.matchAll(/\{\{([^{}]*)\}\}/g)].some(m => !/^(siteName\s*|>\s*family-context\s*)$/.test(m[1]!))) {
    throw Object.assign(new Error("请上传不超过 64 KB 的日报提示词，并保留站名与家友综述引用。"), { statusCode: 400 });
  }
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const [row] = await tx<{ value: State }[]>`SELECT value FROM settings WHERE key=${key}`;
    const previous = row?.value ?? { current: { text: rawPrompt(name), at: null }, history: [] };
    if (expected !== previous.current.at) throw Object.assign(new Error("生效版本已变化，请刷新后重新确认。"), { statusCode: 409 });
    const next = { current: { text, at: new Date().toISOString() }, history: [previous.current, ...previous.history].slice(0, 20) };
    await tx`INSERT INTO settings(key,value,updated_by) VALUES(${key},${tx.json(next)},${actor})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`;
    await audit(actor, "prompt.publish", key, null, previous.current, next.current, { db: tx });
    return next;
  });
}
