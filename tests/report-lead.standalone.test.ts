// A daily's front-page picture comes from the item its lead is about: the editors' lead matched to an
// item by title, never simply the first highlight.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportCitation } from "@aihot/contracts/site";
import { leadItemOf } from "@aihot/backend/publication/reports";

const cite = (itemId: string, title: string, available = true) => ({ itemId, title, available }) as ReportCitation;
const arena = cite("a", "Claude Opus 5.5 (High) 以 1509 分登顶 Arena Text Arena 榜首");
const openai = cite("b", "OpenAI 暂停最强模型的训练与工具使用，披露智能体利用 DNS 漏洞联网及泄露 GitHub token 等安全事件");

test("an editors' lead is matched to the item it is written about", () => {
  assert.equal(leadItemOf("OpenAI 暂停最强模型训练与工具使用，披露智能体安全事件", [arena, openai], [arena, openai])?.itemId, "b");
});

test("a lead that matches no item clearly has no item", () => {
  assert.equal(leadItemOf("多家公司发布新模型，行业竞争加剧", [arena], [arena, openai]), undefined);
});

test("without an editors' lead the first highlight leads", () => {
  assert.equal(leadItemOf(undefined, [arena], [openai, arena])?.itemId, "a");
});

test("a withdrawn highlight never leads the front page", () => {
  const withdrawn = cite("w", "已下架", false);
  assert.equal(leadItemOf(undefined, [withdrawn, arena], [withdrawn, arena, openai])?.itemId, "a");
});

import { arrangeDaily, type EditionEntry } from "@aihot/backend/reports/edition";

test("a useful method follow-up can take a main slot without four sources or official identity", () => {
  const entry = (id: string, previous: boolean): EditionEntry => ({
    entry: { itemId: id, sourceId: id, sources: 1 } as EditionEntry["entry"],
    category: "method", tags: [], storyId: null, mentions: new Set(), sourceIds: new Set([id]),
    authority: 3, importance: 100, previous: previous ? { key: "2026-11-18", title: "earlier" } : null,
  });
  const result = arrangeDaily([entry("new", false), entry("follow-up", true)]);
  assert.deepEqual(result.main.map(e => e.entry.itemId), ["new", "follow-up"]);
});

import { reviewRankedDaily, validateDecisions, type DailyDecision } from "@aihot/backend/reports/review";
const reviewedEntry = (i: number): EditionEntry => ({
  entry: { itemId: `article-${i}`, title: `title ${i}`, summary: `family evidence ${i}`, sourceId: `source-${i}`,
    related: [] } as unknown as EditionEntry["entry"],
  category: "news", tags: [], storyId: i, mentions: new Set(), sourceIds: new Set([`source-${i}`]),
  authority: 3, importance: 100-i, previous: null,
});
const include = (id: string, quote: string): DailyDecision => ({ id, decision: "include", quote, reason: "specific family relevance", exception: false });

test("daily suitability walks ranking batches and stops after enough eligible main and flash entries", async () => {
  const calls: number[] = [];
  const entries = Array.from({ length: 40 }, (_, i) => reviewedEntry(i));
  const result = await reviewRankedDaily(entries, async events => {
    calls.push(events.length);
    return events.flatMap(e => e.reports.map(m => m.id === "article-0"
      ? { ...include(m.id, ""), decision: "exclude" as const }
      : include(m.id, m.summary)));
  }, async () => null);
  assert.deepEqual(calls, [6,6,6,6]);
  assert.equal(result.reviewedEvents, 24);
  assert.equal(result.entries.some(e => e.entry.itemId === "article-0"), false);
  const issue = arrangeDaily(result.entries);
  assert.equal(issue.main.length, 12); assert.equal(issue.flashes.length, 10);
});

test("insufficient summaries fetch body; related reports do not inherit the event decision", async () => {
  const e = reviewedEntry(1);
  e.entry.related = [{ ...reviewedEntry(2).entry }];
  const bodies: string[] = [];
  const result = await reviewRankedDaily([e], async (events, full) => events.flatMap(e => e.reports.map(m => full
    ? include(m.id, "confirmed family passage")
    : { ...include(m.id, ""), decision: m.id === "article-1" ? "needs_body" as const : "exclude" as const })),
    async id => { bodies.push(id); return "confirmed family passage"; });
  assert.deepEqual(bodies, ["article-1"]);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0]!.entry.related, []);
  const missing = await reviewRankedDaily([e], async (events, full) => {
    assert.equal(full, false, "no body review is sent when the body is missing");
    return events.flatMap(event => event.reports.map((m, i) => i === 0
      ? { ...include(m.id, ""), decision: "needs_body" as const }
      : include(m.id, m.summary)));
  }, async () => null);
  assert.equal(missing.entries[0]?.entry.itemId, e.entry.related?.[0]?.itemId);
  assert.equal(missing.decisions.find(d => d.id === e.entry.itemId)?.decision, "needs_body");
});

test("missing decisions and fabricated inclusion evidence fail rather than silently filter or admit", () => {
  const input = [{ id: "a", title: "title", summary: "real summary" }];
  assert.throws(() => validateDecisions(input, []), /missing/);
  assert.throws(() => validateDecisions(input, [include("a", "fabricated")]), /lacks a quote/);
  assert.throws(() => validateDecisions(input, [include("a", "real summary"), include("a", "real summary")]), /duplicate/);
});

test("an included related development survives an excluded original representative with its own metadata", async () => {
  const e = reviewedEntry(0);
  const related = { ...reviewedEntry(1).entry, category: "method", tags: ["家长"], authority: 2, score: 71 };
  e.entry.related = [related];
  const result = await reviewRankedDaily([e], async events => events.flatMap(e => e.reports.map(m => m.id === "article-0"
    ? { ...include(m.id, ""), decision: "exclude" as const } : include(m.id, m.summary))), async () => null);
  assert.equal(result.entries[0]!.entry.itemId, "article-1");
  assert.equal(result.entries[0]!.entry.sourceId, "source-1");
  assert.equal(result.entries[0]!.entry.score, 71);
  assert.equal(result.entries[0]!.category, "method");
  assert.deepEqual(result.entries[0]!.tags, ["家长"]);
  assert.deepEqual(result.entries[0]!.entry.related, []);
});

test("a body review that still cannot decide is not an exclusion or a publishable result", async () => {
  await assert.rejects(reviewRankedDaily([reviewedEntry(0)], async events => events.flatMap(e => e.reports.map(m => ({
    ...include(m.id, ""), decision: "needs_body" as const,
  }))), async () => "incomplete confirmed body"), /incomplete review with no publishable articles/);
});

test("an unusable model batch leaves later candidates eligible", async () => {
  const { ModelOutputError } = await import("@aihot/backend/providers/receipts");
  const entries = Array.from({ length: 7 }, (_, i) => reviewedEntry(i));
  const result = await reviewRankedDaily(entries, async events => {
    if (events.some(e => e.id === "article-0")) throw new ModelOutputError("invalid output", 12);
    return events.flatMap(e => e.reports.map(m => include(m.id, m.summary)));
  }, async () => null);
  assert.deepEqual(result.entries.map(e => e.entry.itemId), ["article-6"]);
  assert.equal(result.skippedBatches[0]?.receiptId, 12);
});
