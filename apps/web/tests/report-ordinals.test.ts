// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
// Failure cases: the masthead numbering the newest of 405 issues 400 (the navigation index's length); an
// issue older than the index losing its number; the calendar marking that issue as not published; the
// daily archive counting 400 issues beside a masthead that numbers 405.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReportDetail, ReportKind, ReportNavigationEntry } from "@aihot/contracts/site";
import { isoWeekLabel } from "@aihot/contracts/time";
import { issueNumber, periodGrid } from "../app/features/report/format.ts";
import { fakeApi, startWebServer, type WebServer } from "./web-server.ts";

const kinds: ReportKind[] = ["daily", "weekly", "monthly"];
const keys = Object.fromEntries(kinds.map((kind) => [kind, Array.from({ length: 405 }, (_, i) => {
  if (kind === "monthly") return new Date(Date.UTC(2020, i, 1)).toISOString().slice(0, 7);
  const day = new Date(Date.UTC(2020, 0, 6 + i * (kind === "weekly" ? 7 : 1))).toISOString().slice(0, 10);
  return kind === "weekly" ? isoWeekLabel(day) : day;
})])) as Record<ReportKind, string[]>;
/** The navigation as the api sends it: the newest 400 issues, each with its number in the whole series. */
const index = (kind: ReportKind): ReportNavigationEntry[] => keys[kind].map((key, i) => ({ key, issueNumber: i + 1, title: `第${i + 1}期` })).reverse().slice(0, 400);
function report(kind: ReportKind, key: string): ReportDetail {
  return {
    kind, key, issueNumber: keys[kind].indexOf(key) + 1, title: "测试刊物", generatedAt: "2020-01-02T00:00:00Z",
    lead: null, leadItemId: null, overview: null, highlights: [], sections: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null,
  };
}
const previewKey = "2026-11-18";
let updated = false;
let checks = 0;
let started = false;
const previewReport = (): ReportDetail => ({ ...report("daily", previewKey), issueNumber: 406, generatedAt: updated ? "2026-11-19T03:00:00Z" : "2026-11-18T00:00:00Z",
  leadItemId: "fixture-main", lead: { title: "家长与孩子共同探索AI的学习方法", leadParagraph: updated ? "重新生成完成后的摘要" : "家长和孩子一起讨论AI使用边界。" },
  sections: [{ label: "方法", summary: null, items: [{ itemId: "fixture-main", title: "家长与孩子共同探索AI的学习方法", summary: "一起讨论具体的学习步骤与适用条件。",
    sourceName: "测试来源", sourceUrl: "https://example.org", sourceIconUrl: null, firstParty: false, publishedAt: null, available: true,
    dailyStatus: { selected: true, hot: true, fromRadar: null, score: 86 } }] }],
});
let web: WebServer;
const api = fakeApi((url, res, req) => {
  if (url.pathname === "/api/admin/me") {
    if (!req.headers.cookie?.includes("fixture_admin=1")) { res.statusCode = 401; return {}; }
    return { name: "测试管理员", csrf: "fixture-csrf", dev: false };
  }
  if (url.pathname.endsWith("/regenerate")) {
    assert.equal(req.headers["x-csrf-token"], "fixture-csrf");
    started = true; checks = 0;
    return { run: { id: "fixture-run", status: "queued", finishedAt: null, error: null } };
  }
  if (url.pathname.endsWith("/regeneration")) {
    if (!started) return { run: null };
    updated = ++checks > 1;
    return { run: { id: "fixture-run", status: updated ? "done" : "running", finishedAt: updated ? "2026-11-19T03:00:01Z" : null, error: null } };
  }
  if (url.pathname === `/api/site/reports/daily/${previewKey}`) return previewReport();
  const path = url.pathname;
  if (path === "/api/site/reports/daily") return { kind: "daily", items: index("daily").map((entry) => ({ ...entry, count: 1 })) };
  const match = /^\/api\/site\/reports\/(daily|weekly|monthly)\/(.+)$/.exec(path);
  if (match) {
    const kind = match[1] as ReportKind;
    const key = match[2]!;
    if (key === "latest-page") return { index: index(kind), report: report(kind, keys[kind].at(-1)!) };
    if (key.startsWith("navigation/")) return { items: index(kind) };
    if (keys[kind].includes(key)) return report(kind, key);
  }
});

before(async () => { web = await startWebServer(api); });
after(() => web.stop());

/** The masthead's visible text (the archive's has the same frame). */
function masthead(html: string): string {
  const header = /<header class="pt-5 lg:pt-0">([\s\S]*?)<\/header>/.exec(html);
  assert.ok(header, "the report masthead is rendered");
  return header[1]!.replace(/<[^>]+>/g, "");
}

for (const kind of kinds) {
  test(`the ${kind} masthead numbers the newest of 405 issues 405, not the navigation's 400`, async () => {
    const response = await fetch(`${web.origin}/${kind}`);
    assert.equal(response.status, 200, web.logs());
    const visible = masthead(await response.text());
    assert.match(visible, /第\s*405\s*期/);
    assert.doesNotMatch(visible, /第\s*400\s*期/);
  });

  test(`the oldest ${kind} issue, outside the navigation, keeps its number`, async () => {
    const first = keys[kind][0]!;
    assert.ok(!index(kind).some((entry) => entry.key === first));
    const response = await fetch(`${web.origin}/${kind}/${first}`);
    assert.equal(response.status, 200, web.logs());
    assert.match(masthead(await response.text()), /第\s*1\s*期/);
  });

  test(`the ${kind} calendar labels this issue with its own number and makes up none for others`, () => {
    const first = keys[kind][0]!;
    const { cells } = periodGrid(kind, first, index(kind), 1);
    const current = cells.find((cell) => cell.key === first)!;
    assert.equal(current.state, "current");
    assert.match(current.label, /第 1 期/);
    const unlisted = cells.find((cell) => cell.key === keys[kind][1])!;
    assert.doesNotMatch(unlisted.label, /第 \d+ 期/, "an issue the navigation does not list gets no number");
    assert.equal(issueNumber(index(kind), keys[kind].at(-1)!), 405);
    const stale = periodGrid(kind, first, [{ key: first, issueNumber: 9 }], 10);
    assert.match(stale.cells.find((cell) => cell.key === first)!.label, /第 10 期/, "the report's own number wins over an older navigation");
  });
}

test("the daily archive counts every issue, as the masthead numbers them", async () => {
  const response = await fetch(`${web.origin}/daily/archive`);
  assert.equal(response.status, 200, web.logs());
  assert.match(masthead(await response.text()), /共\s*405\s*期/);
});


test("daily labels and administrator-only regeneration work through the production page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`${web.origin}/daily/${previewKey}`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.getByRole("button", { name: "重新生成", exact: true }).count(), 0);
    assert.ok(await page.getByText("精选", { exact: true }).count());
    assert.ok(await page.getByText("热点", { exact: true }).count());
    assert.ok(await page.getByText("AI评分 86", { exact: true }).count());
    await page.context().addCookies([{ name: "fixture_admin", value: "1", url: web.origin }]);
    await page.reload();
    const button = page.getByRole("button", { name: "重新生成", exact: true });
    await button.waitFor();
    await button.click();
    await page.getByRole("button", { name: "重新生成中…" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "重新生成中…" }).isDisabled(), true);
    await page.getByText("重新生成完成后的摘要", { exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "重新生成", exact: true }).waitFor();
    await page.screenshot({ path: "/private/tmp/eduhot-daily-regenerated.png", fullPage: true });
    assert.equal(started, true);
  } finally { await browser.close(); }
});
