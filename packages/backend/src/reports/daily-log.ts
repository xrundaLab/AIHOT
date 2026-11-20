import { sql } from "../db.ts";
import type { DailyLogLink } from "./edition.ts";

const sections = [
  ["initial", "初筛候选"],
  ["supplements", "补充候选"],
  ["events", "事件合并后"],
  ["selected", "最终选稿"],
] as const;

export async function dailyLogMarkdown(date: string): Promise<string | null> {
  const [row] = await sql<{ log: Record<(typeof sections)[number][0], DailyLogLink[]> | null }[]>`
    SELECT content->'dailyLog' AS log FROM reports WHERE kind = 'daily' AND key = ${date}`;
  if (!row?.log) return null;
  const log = row.log;
  return sections.map(([key, heading]) => {
    const links = log[key].flatMap(({ title, url }) => {
      try {
        const target = new URL(url);
        if (target.protocol !== "http:" && target.protocol !== "https:") return [];
        const label = title.replace(/[\r\n]+/g, " ").replace(/[\\\[\]<>]/g, "\\$&");
        return [`- [${label}](<${target.href.replace(/[<>]/g, encodeURIComponent)}>)`];
      } catch {
        return [];
      }
    });
    return [`## ${heading}`, "", ...links, ""].join("\n");
  }).join("\n");
}
