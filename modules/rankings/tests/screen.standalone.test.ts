import { strict as assert } from "node:assert";
import { test } from "node:test";
import { judgementSchema } from "../backend/screen.ts";

test("judgements belong to every original row in this snapshot", () => {
  const items = [{ rank: 2, title: "第一条", url: null, heat: "", origin: "" }, { rank: 9, title: "第二条", url: null, heat: "", origin: "" }];
  const fetchedAt = new Date("2026-11-10T08:00:00.000Z");
  const schema = judgementSchema({ name: "榜单", source: "来源", items, source_updated: null, fetched_at: fetchedAt });
  const results = items.map((i, index) => ({ rank: i.rank, title: i.title, level: index ? "B" : "A", reason: "待看原文", caution: "", related_ranks: [] }));
  const answer = { board_name: "榜单", source: "来源", board_updated_at: null, fetched_at: fetchedAt.toISOString(), results };
  assert.equal(schema.safeParse(answer).success, true);
  assert.equal(schema.safeParse({ ...answer, results: results.slice(0, 1) }).success, false);
  assert.equal(schema.safeParse({ ...answer, results: [...results].reverse() }).success, false);
  assert.equal(schema.safeParse({ ...answer, results: [{ ...results[0], title: "不同标题" }, results[1]] }).success, false);
  assert.equal(schema.safeParse({ ...answer, results: [{ ...results[0], related_ranks: [2] }, results[1]] }).success, false);
  assert.equal(schema.safeParse({ ...answer, board_name: "另一个榜单" }).success, false);
  assert.equal(schema.safeParse({ ...answer, fetched_at: "2026-11-10T07:00:00.000Z" }).success, false);
});

test("a normalized space in a model title keeps the original snapshot title", () => {
  const items = [{ rank: 26, title: "AMD\u00a0Zen 6，正式发布", url: null, heat: "", origin: "" }];
  const fetchedAt = new Date("2026-11-11T11:10:30.172Z");
  const schema = judgementSchema({ name: "榜单", source: "来源", items, source_updated: null, fetched_at: fetchedAt });
  const answer = { board_name: "榜单", source: "来源", board_updated_at: null, fetched_at: fetchedAt.toISOString(),
    results: [{ rank: 26, title: "AMD Zen 6，正式发布", level: "C", reason: "芯片发布", caution: "", related_ranks: [] }] };
  const parsed = schema.safeParse(answer);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.results[0]!.title, items[0]!.title);
  assert.equal(schema.safeParse({ ...answer, results: [{ ...answer.results[0], title: "AMD Zen 7，正式发布" }] }).success, false);
});
