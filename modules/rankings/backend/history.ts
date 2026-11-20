import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { sql } from "@aihot/backend/db";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { readableDetailCondition } from "@aihot/backend/publication/scope";
import type { Entry } from "./tunbang.ts";
import type { RankingJudgement } from "./screen.ts";

const PAGE_SIZE = 30;
export interface HistoryOccurrence { source: string; board: string; boardId: string; rank: number; fetchedAt: string; judgement: RankingJudgement }
export interface HistoryItem { title: string; url: string | null; detailUrl?: string; origin: string; firstAt: string; lastAt: string; occurrences: HistoryOccurrence[] }
export interface RadarHistory { date: string; source: string | null; board: string | null; sources: string[]; boards: Array<{ id: string; name: string; source: string }>; items: HistoryItem[]; page: number; pageCount: number; total: number }
interface Snapshot { id: number; board_id: string; name: string; source: string; fetched_at: Date; items: Entry[]; results: RankingJudgement[] | null }

export function validHistoryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const start = beijingMidnight(value);
  return Number.isFinite(start.getTime()) && beijingDate(start) === value;
}

/** Beijing calendar-day history, preserving the judgements saved on each independent snapshot. */
export async function loadRadarHistory(date: string, source: string | null, board: string | null, page: number, now = new Date()): Promise<RadarHistory> {
  if (!validHistoryDate(date)) throw new Error("invalid date");
  const from = beijingMidnight(date), to = new Date(from.getTime() + 86400000);
  // Screening validates that results and original rows have identical positions and ranks.
  // Project only A entries in PostgreSQL instead of sending entire raw hourly boards to the API.
  const snapshots = await sql<Snapshot[]>`SELECT s.id,s.board_id,s.name,s.source,s.fetched_at,chosen.items,chosen.results
    FROM external_ranking_snapshots s
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(jsonb_build_object('rank',entry->'rank','title',entry->'title','url',entry->'url','origin',entry->'origin') ORDER BY j.ord), '[]'::jsonb) AS items,
        coalesce(jsonb_agg(j.value ORDER BY j.ord), '[]'::jsonb) AS results
      FROM jsonb_array_elements(coalesce(s.results,'[]'::jsonb)) WITH ORDINALITY j(value,ord)
      CROSS JOIN LATERAL (SELECT s.items->((j.ord-1)::int) AS entry) original
      WHERE j.value->>'level'='A' AND entry->>'rank'=j.value->>'rank' AND entry->>'title'=j.value->>'title'
    ) chosen
    WHERE s.status='complete' AND s.fetched_at>=${from} AND s.fetched_at<${to}
    ORDER BY s.fetched_at DESC,s.id DESC`;
  const sources = [...new Set(snapshots.map(s => s.source))].sort((a,b) => a.localeCompare(b, "zh-CN"));
  const boards = [...new Map(snapshots.filter(s => !source || s.source === source).map(s => [s.board_id, { id: s.board_id, name: s.name, source: s.source }])).values()]
    .sort((a,b) => a.source.localeCompare(b.source, "zh-CN") || a.name.localeCompare(b.name, "zh-CN"));
  const selected = snapshots.filter(s => (!source || s.source === source) && (!board || s.board_id === board));
  const ids = selected.map(s => s.id);
  const associations = ids.length ? await sql<{ snapshot_id: number; rank: number; article_id: string | null; hidden: boolean }[]>`
    SELECT o.snapshot_id,o.rank,CASE WHEN ${readableDetailCondition(now)} THEN p.article_id ELSE NULL END AS article_id,
      coalesce(e.visibility='withdrawn' OR (p.visibility='withdrawn' AND s.participation_mode<>'isolated'),false) AS hidden
    FROM radar_body_occurrences o JOIN radar_body_tasks t ON t.id=o.task_id LEFT JOIN publications p ON p.article_id=t.article_id
    LEFT JOIN articles a ON a.id=t.article_id LEFT JOIN sources s ON s.id=a.source_id LEFT JOIN editorial_overrides e ON e.article_id=a.id
    WHERE o.snapshot_id=ANY(${ids}::bigint[])` : [];
  const matched = new Map(associations.filter(x => x.article_id).map(x => [`${x.snapshot_id}:${x.rank}`, x.article_id!]));
  const hiddenOccurrences = new Set(associations.filter(x => x.hidden).map(x => `${x.snapshot_id}:${x.rank}`));
  const hiddenGroups = new Set<string>();
  const groups = new Map<string, HistoryItem>();
  const originalUrls = new Map<HistoryItem, Set<string>>();
  for (const snapshot of selected) {
    const judgments = new Map((snapshot.results ?? []).map(j => [j.rank, j]));
    for (const item of snapshot.items) {
      const judgment = judgments.get(item.rank);
      if (!judgment || judgment.level !== "A" || judgment.title !== item.title) continue;
      const safeUrl = item.url && /^https?:\/\//i.test(item.url) && identityKeyForUrl(item.url) ? item.url : null;
      const key = (safeUrl && identityKeyForUrl(safeUrl)) || `snapshot:${snapshot.id}:${item.rank}`;
      if (hiddenOccurrences.has(`${snapshot.id}:${item.rank}`)) hiddenGroups.add(key);
      const at = snapshot.fetched_at.toISOString();
      let group = groups.get(key);
      if (!group) {
        const articleId = matched.get(`${snapshot.id}:${item.rank}`);
        group = { title: item.title, url: safeUrl, origin: item.origin || "", ...(articleId ? { detailUrl: `/items/${encodeURIComponent(articleId)}` } : {}), firstAt: at, lastAt: at, occurrences: [] };
        groups.set(key, group);
        originalUrls.set(group, new Set());
      } else if (!group.detailUrl) {
        const articleId = matched.get(`${snapshot.id}:${item.rank}`);
        if (articleId) group.detailUrl = `/items/${encodeURIComponent(articleId)}`;
      }
      if (safeUrl) originalUrls.get(group)!.add(safeUrl);
      group.firstAt = at < group.firstAt ? at : group.firstAt;
      group.occurrences.push({ source: snapshot.source, board: snapshot.name, boardId: snapshot.board_id, rank: item.rank, fetchedAt: at,
        judgement: { rank: judgment.rank, title: judgment.title, level: judgment.level, reason: judgment.reason, caution: judgment.caution, related_ranks: judgment.related_ranks } });
    }
  }
  // An explicitly withdrawn article must not be revived by an old public snapshot. The
  // isolated radar source is not a withdrawal decision: it is simply unpublished material.
  for (const key of hiddenGroups) groups.delete(key);
  const identities = [...groups.keys()].filter(key => !key.startsWith("snapshot:"));
  if (identities.length) {
    const states = await sql<{ identity_key: string; visibility: string | null; source_mode: string; override_visibility: string | null }[]>`
      SELECT a.identity_key,p.visibility,s.participation_mode AS source_mode,o.visibility AS override_visibility
      FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN publications p ON p.article_id=a.id
      LEFT JOIN editorial_overrides o ON o.article_id=a.id WHERE a.identity_key=ANY(${identities}::text[])`;
    for (const state of states) if (state.override_visibility === "withdrawn" || (state.visibility === "withdrawn" && state.source_mode !== "isolated")) groups.delete(state.identity_key);
  }
  const all = [...groups.values()];
  // Older snapshots predate the durable task association; exact URL is safe when unambiguous.
  const urls = [...new Set(all.filter(x => !x.detailUrl).flatMap(x => [...originalUrls.get(x)!]))];
  if (urls.length) {
    const rows = await sql<{ url: string; id: string; count: number }[]>`SELECT p.url,min(p.article_id) AS id,count(*)::int AS count FROM publications p
      WHERE p.url=ANY(${urls}::text[]) AND ${readableDetailCondition(now)} GROUP BY p.url`;
    const byUrl = new Map(rows.map(r => [r.url, r.count === 1 ? r.id : null]));
    for (const item of all) if (!item.detailUrl) {
      const candidates = [...originalUrls.get(item)!].filter(url => byUrl.has(url)).map(url => byUrl.get(url));
      const matches = new Set(candidates.filter((id): id is string => !!id));
      if (!candidates.includes(null) && matches.size === 1) item.detailUrl = `/items/${encodeURIComponent([...matches][0]!)}`;
    }
  }
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const actualPage = Math.max(1, Math.min(Math.floor(page) || 1, pageCount));
  return { date, source, board, sources, boards, items: all.slice((actualPage-1)*PAGE_SIZE, actualPage*PAGE_SIZE), page: actualPage, pageCount, total: all.length };
}
