// Reports: a scheduled run that starts late still writes the issue it was due for, never one whose
// window is still open; a daily whose window nothing was judged in is refused rather than published as a
// quiet day; and an older weekly that froze no summaries shows the cited articles' public summaries.
import { editionAt, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadReport } from "@aihot/backend/publication/reports";
import { composeDaily, dueDaily, dueMonthly, dueWeekly } from "@aihot/backend/reports/compose";
import { SITE } from "@aihot/site";

const T = tag();
const SOURCE = `test-reports-${T}`;
const WEEK = "2098-W20";
after(async () => {
  await stopBoss();
  await closeDb();
});

test("a late run writes the issue that was due, not today's", () => {
  assert.equal(dueDaily(editionAt("daily", "2026-09-29", 6)), "2026-09-29");
  assert.equal(dueDaily(editionAt("daily", "2026-09-30", -60)), "2026-09-29", "the 29th's run delayed until just before the next issue");
  assert.equal(dueWeekly(editionAt("weekly", "2026-09-28")), "2026-W39");
  assert.equal(dueWeekly(editionAt("weekly", "2026-10-05", -60)), "2026-W39", "Monday before its edition time: the next week is not due yet");
  assert.equal(dueWeekly(editionAt("weekly", "2026-10-05", 60)), "2026-W40");
  assert.equal(dueMonthly(editionAt("monthly", "2026-10-01")), "2026-09");
  assert.equal(dueMonthly(editionAt("monthly", "2026-10-01", -60)), "2026-08");
  assert.equal(dueMonthly(editionAt("monthly", "2027-01-15")), "2026-12");
});

test("a daily with nothing judged in its window is refused, not published as a quiet day", async () => {
  const date = "2098-01-15";
  await assert.rejects(composeDaily(date), /nothing judged/);
  const [row] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${date}`;
  assert.equal(row, undefined);
});

test("a weekly that froze no summaries shows the articles' public summaries", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Reports', 'rss', 'T1', 'editorial', '2100-01-01')`;
  // Found, published and released a minute ago: a rolling window that ends at the reader's clock holds it.
  const minuteAgo = new Date(Date.now() - 60_000);
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}`, title: `R ${T}`, bodyText: "b", bodyHtml: "<p>b</p>", bodyStatus: "ok", via: "fetch", publishedAt: minuteAgo, discoveredAt: minuteAgo });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`标题-${T}`}, ${`公开摘要-${T}`}, 80, true)`;
  await publishArticle(articleId, { releasedAt: minuteAgo });
  const content = { kind: "weekly", title: `${SITE.name} 周报 · ${WEEK}`, overview: "o", themes: [{ heading: "h", summary: "s", storyRefs: [{ itemId: articleId, title: `标题-${T}`, sourceName: "Old aggregator", sourceId: "old-source", firstParty: false, sourceUrl: "https://example.com" }] }] };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
            VALUES ('weekly', ${WEEK}, now(), now(), ${sql.json(content as never)}, now(), 'imported')`;
  const report = await loadReport("weekly", WEEK);
  assert.equal(report?.sections[0]?.items[0]?.summary, `公开摘要-${T}`);
  assert.equal(report?.sections[0]?.items[0]?.sourceName, "Reports");
  assert.equal(report?.sections[0]?.items[0]?.firstParty, true, "a frozen citation cannot override verified current provenance");
  await sql`UPDATE sources SET tier = 'T1_5', first_party = true WHERE id = ${SOURCE}`;
  await publishArticle(articleId);
  assert.equal((await loadReport("weekly", WEEK))?.sections[0]?.items[0]?.firstParty, false);
});

test("daily prompt publish pins a version and can restore the prior wording", async () => {
  const { dailyPrompt, dailyPromptForRun, publishDailyPrompt } = await import("@aihot/backend/reports/daily-prompt");
  const baseline = await dailyPrompt();
  await assert.rejects(publishDailyPrompt("missing includes", baseline.current.at, "test"), { statusCode: 400 });
  const wording = baseline.current.text + "\n日报提示词测试版本。\n";
  const published = await publishDailyPrompt(wording, baseline.current.at, "test");
  assert.match((await dailyPromptForRun()).system, /日报提示词测试版本/);
  await assert.rejects(publishDailyPrompt(wording, baseline.current.at, "test"), { statusCode: 409 });
  await publishDailyPrompt(published.history[0]!.text, published.current.at, "test");
  assert.equal((await dailyPrompt()).current.text, baseline.current.text);
});

test("daily Markdown includes the issue link and public archive data", async () => {
  const { dailyMarkdown } = await import("@aihot/backend/publication/daily-markdown");
  const date = "2098-01-16";
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at)
    VALUES('daily',${date},now(),now(),${sql.json({ title: "日报导出", sections: [], flashes: [] })},now())`;
  const markdown = await dailyMarkdown(date);
  assert.match(markdown ?? "", /日报日期：2098-01-16/);
  assert.match(markdown ?? "", /\/daily\/2098-01-16>/);
  assert.equal(await dailyMarkdown("2098-01-17"), null);
});
