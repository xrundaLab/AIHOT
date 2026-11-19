// Suitability is a daily-only editorial decision, paid and receipted like the other model steps.
import { z } from "zod";
import { sql } from "../db.ts";
import { dailyPromptForRun } from "./daily-prompt.ts";
import { modelFor } from "../editorial/models.ts";
import { chatJson } from "../providers/llm.ts";
import { ModelOutputError } from "../providers/receipts.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { arrangeDaily, MAIN_ENTRIES, FLASH_ENTRIES, type EditionEntry } from "./edition.ts";

const Decision = z.object({
  id: z.string(), decision: z.enum(["include", "exclude", "needs_body"]),
  reason: z.string().trim().min(1).max(400), quote: z.string().max(1500), exception: z.boolean(),
});
const Schema = z.object({ decisions: z.array(Decision) });
export type DailyDecision = z.infer<typeof Decision>;
export interface ReviewMaterial { id: string; title: string; summary: string; body?: string }
export type ReviewBatch = (events: Array<{ id: string; reports: ReviewMaterial[] }>, full: boolean) => Promise<DailyDecision[]>;
const QUOTE_ERROR = "daily review: inclusion lacks a quote from this article's input";
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

/** Reject partial or unsupported model responses instead of silently losing or admitting candidates. */
export function validateDecisions(materials: ReviewMaterial[], decisions: DailyDecision[]) {
  const byId = new Map(materials.map(m => [m.id, m]));
  const seen = new Set<string>();
  for (const d of decisions) {
    const m = byId.get(d.id);
    if (!m || seen.has(d.id)) throw new Error("daily review: unexpected or duplicate article id");
    seen.add(d.id);
    if (d.decision === "include") {
      const quote = normalize(d.quote);
      if (!quote || ![m.summary, m.body ?? ""].some(text => normalize(text).includes(quote))) {
        throw new Error(QUOTE_ERROR);
      }
    }
  }
  if (seen.size !== byId.size) throw new Error("daily review: missing article decision");
}

/** Walk the ranking in bounded batches; source diversity can require reading beyond the first 22. */
export async function reviewRankedDaily(entries: EditionEntry[], batch: ReviewBatch,
  bodyOf: (id: string) => Promise<string | null>) {
  const accepted: EditionEntry[] = [];
  const decisions: DailyDecision[] = [];
  let reviewedEvents = 0;
  const skippedBatches: Array<{ articleIds: string[]; stage: "summary" | "body"; receiptId: number | null }> = [];
  const tryBatch: ReviewBatch = async (events, full) => {
    try {
      const decisions = await batch(events, full);
      validateDecisions([...new Map(events.flatMap(event => event.reports).map(report => [report.id, report])).values()], decisions);
      return decisions;
    } catch (error) {
      shutdownSignal.signal.throwIfAborted();
      if (!(error instanceof ModelOutputError)) throw error;
      skippedBatches.push({ articleIds: [...new Set(events.flatMap(event => event.reports.map(report => report.id)))],
        stage: full ? "body" : "summary", receiptId: error.receiptId });
      return [];
    }
  };
  for (let offset = 0; offset < entries.length; offset += 6) {
    shutdownSignal.signal.throwIfAborted();
    const candidates = entries.slice(offset, offset + 6);
    const events = candidates.map(e => ({ id: e.entry.itemId, reports: [e.entry, ...(e.entry.related ?? [])].map(r => ({
      id: r.itemId, title: r.title, summary: r.summary ?? "",
    })) }));
    const material = events.flatMap(e => e.reports);
    // One article can be cited by multiple event candidates; the model still decides it once.
    const unique = [...new Map(material.map(m => [m.id, m])).values()];
    const first = await tryBatch(events, false);
    if (!first.length && unique.length) continue;
    validateDecisions(unique, first);
    const resolved = new Map(first.map(d => [d.id, d]));
    const pending = first.filter(d => d.decision === "needs_body");
    if (pending.length) {
      const reports = await Promise.all(pending.map(async d => {
        const body = await bodyOf(d.id);
        if (!body?.trim()) return null;
        return { ...unique.find(m => m.id === d.id)!, body: body.slice(0, 20000) };
      }));
      // Keep missing bodies as needs_body in the audit and omit those articles from the issue.
      const available = reports.filter(report => report !== null);
      const full = available.length
        ? await tryBatch(available.map(m => ({ id: m.id, reports: [m] })), true)
        : [];
      if (full.length) validateDecisions(available, full);
      for (const d of full) resolved.set(d.id, d);
    }
    decisions.push(...resolved.values());
    reviewedEvents += candidates.length;
    for (const e of candidates) {
      const reports = [e.entry, ...(e.entry.related ?? [])]
        .filter(r => resolved.get(r.itemId)?.decision === "include");
      const primary = reports[0];
      if (!primary) continue;
      const promoted = primary.itemId !== e.entry.itemId;
      const metadata = primary as { category?: string | null; tags?: string[]; authority?: number };
      accepted.push({ ...e,
        category: promoted ? metadata.category ?? null : e.category,
        tags: promoted ? metadata.tags ?? [] : e.tags,
        authority: promoted ? metadata.authority ?? 3 : e.authority,
        entry: { ...e.entry, ...primary, related: reports.slice(1) },
      });
    }
    const issue = arrangeDaily(accepted);
    if (issue.main.length >= MAIN_ENTRIES && issue.flashes.length >= FLASH_ENTRIES) break;
  }
  if (!accepted.length && (skippedBatches.length || decisions.some(d => d.decision === "needs_body"))) {
    throw new Error("daily review: incomplete review with no publishable articles");
  }
  return { entries: accepted, decisions, reviewedEvents, skippedBatches };
}

export async function reviewDaily(date: string, entries: EditionEntry[], attemptTag?: string) {
  const model = await modelFor("report");
  const receiptIds: number[] = [];
  const { system, version } = await dailyPromptForRun();
  const result = await reviewRankedDaily(entries, async (events, full) => {
    const articles = [...new Map(events.flatMap(e => e.reports.map(report => [report.id, { eventId: e.id, report }] as const))).values()];
    const decisions: DailyDecision[] = [];
    for (let offset = 0; offset < articles.length;) {
      const chunk: typeof articles = [];
      let size = 0;
      while (offset < articles.length && chunk.length < 12) {
        const next = articles[offset]!;
        const length = JSON.stringify(next).length;
        if (chunk.length && size + length > 24000) break;
        chunk.push(next); size += length; offset++;
      }
      const groups = new Map<string, ReviewMaterial[]>();
      for (const item of chunk) groups.set(item.eventId, [...(groups.get(item.eventId) ?? []), item.report]);
      const request = (quoteRetry: boolean) => chatJson({
        model, purpose: "report_daily_review", subject: `report:daily:${date}`, promptVersion: version,
        system, user: JSON.stringify({ materialStatus: full ? "已确认正文（超长时仅提供前20000字符）" : "摘要，可能不完整",
          events: [...groups].map(([id, reports]) => ({ id, reports })),
          ...(quoteRetry ? { correction: "上一次引文未通过校验。每条 include 的 quote 请逐字复制该条 id 的 summary 或 body 中连续的一小段，保留标点，不拼接、不改写、不加省略号。无法从当前材料支持收录时，按规则返回 exclude 或 needs_body。请重新输出本批全部决定。" } : {}),
        }),
        schema: Schema.superRefine((value, context) => {
          try { validateDecisions(chunk.map(item => item.report), value.decisions); }
          catch (error) { context.addIssue({ code: "custom", message: (error as Error).message }); }
        }), temperature: 0.2, maxTokens: 8192, attemptTag,
      });
      const response = await request(false).catch(error => {
        if (!(error instanceof ModelOutputError) || !error.message.includes(QUOTE_ERROR)) throw error;
        return request(true);
      });
      validateDecisions(chunk.map(item => item.report), response.data.decisions);
      receiptIds.push(response.receiptId);
      decisions.push(...response.data.decisions);
    }
    return decisions;
  }, async id => {
    const [row] = await sql<{ body: string | null }[]>`
      SELECT coalesce(CASE WHEN a.body_status = 'ok' THEN nullif(a.body_text, '') END,
        nullif(concat_ws(E'\n\n', a.x_post->>'text', a.x_post->'quoted'->>'text', a.x_article->>'text'), '')) AS body
      FROM articles a JOIN publications p ON p.article_id = a.id JOIN sources s ON s.id = p.source_id
      WHERE a.id = ${id} AND p.visibility = 'public' AND s.participation_mode = 'editorial'`;
    return row?.body ?? null;
  });
  return { ...result, receiptIds, model, version };
}
