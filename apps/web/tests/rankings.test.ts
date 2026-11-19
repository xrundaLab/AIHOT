import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { fakeApi, startWebServer, visit, type WebServer } from "./web-server.ts";
const common = { items: [], sourceUpdated: null, fetchedAt: null, failed: false };
const boards = [
  { ...common, id: "family:48", name: "48小时", source: "家友榜", url: "/all", items: [{ rank: 1, title: "家友动态", url: "/items/example", heat: "90 分", origin: "来源" }] },
  { ...common, id: "tunbang:all", name: "全网热搜总榜", source: "豚榜", url: "https://tunbang.com/hot/", screenStatus: "complete", items: [{ rank: 1, title: "测试热点", url: "https://example.org/", detailUrl: "/items/matched", bodyState: "external", heat: "10万", origin: "微博" }, { rank: 2, title: "其他线索", url: null, heat: "", origin: "" }, { rank: 3, title: "普通内容", url: null, heat: "", origin: "" }], judgements: [{ rank: 1, title: "测试热点", level: "A", reason: "学校议题", caution: "待核实", related_ranks: [] }, { rank: 2, title: "其他线索", level: "B", reason: "家庭消费", caution: "待看原文", related_ranks: [] }, { rank: 3, title: "普通内容", level: "C", reason: "无明确线索", caution: "", related_ranks: [] }] },
  { ...common, id: "wxrank:article", name: "热门文章", source: "微小榜", url: "https://wxrank.com/rank/article", unavailable: "榜单接口需要登录或授权，暂未接入。" },
  { ...common, id: "fixture:pending", name: "判断中榜单", source: "测试", url: "https://example.org/", screenStatus: "pending", items: [{ rank: 8, title: "未判断标题", url: null, heat: "", origin: "" }] },
  { ...common, id: "fixture:failed", name: "判断失败榜单", source: "测试", url: "https://example.org/", screenStatus: "failed", items: [{ rank: 9, title: "失败榜单标题", url: null, heat: "", origin: "" }] },
];
let web: WebServer; let browser: Browser;
before(async () => { web = await startWebServer(fakeApi(url => {
  if (url.pathname === "/api/site/rankings") return { boards };
  if (url.pathname === "/api/site/rankings/history") {
    const date = url.searchParams.get("date"), source = url.searchParams.get("source"), board = url.searchParams.get("board"), page = Number(url.searchParams.get("page") || 1);
    return { date, source, board, sources: ["豚榜", "微小榜"], boards: [{ id: "tunbang:all", name: "全网热搜总榜", source: "豚榜" }], page, pageCount: 2, total: 31,
      items: [{ title: page === 1 ? "历史热点" : "第二页热点", url: "https://example.org/history", detailUrl: "/items/history", origin: "来源", firstAt: "2026-11-19T00:00:00Z", lastAt: "2026-11-19T02:00:00Z", occurrences: [{ source: "豚榜", board: "全网热搜总榜", boardId: "tunbang:all", rank: 1, fetchedAt: "2026-11-19T02:00:00Z", judgement: { rank: 1, title: "历史热点", level: "A", reason: "当时的判断", caution: "当时的提示", related_ranks: [] } }] }] };
  }
})); browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close(); await web?.stop(); });
for (const width of [393, 1200]) test(`rankings search and selection at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  try {
    await visit(page, `${web.origin}/rankings?board=family%3A48`);
    const article = page.getByRole("link", { name: "家友动态", exact: true });
    await expect(article).toBeVisible();
    await expect(article).toHaveAttribute("href", "/items/example");
    await expect(page.getByText("90 分")).toBeVisible();
    if (width < 961) await page.getByRole("button", { name: /选择榜单/ }).click();
    await page.getByRole("searchbox", { name: "搜索榜单或来源" }).fill("微小榜");
    await page.getByRole("button", { name: "热门文章" }).click();
    await expect(page.getByText("榜单接口需要登录或授权，暂未接入。")).toBeVisible();
    await expect(page).toHaveURL(/board=wxrank/);
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    if (size.scroll > size.width + 1) throw new Error(`page overflows: ${size.scroll} > ${size.width}`);
  } finally { await page.close(); }
});

test("directly relevant items are repeated at the top without changing the original list", async () => {
  const page = await browser.newPage({ viewport: { width: 393, height: 850 } });
  try {
    await visit(page, `${web.origin}/rankings?board=tunbang%3Aall`);
    const section = page.getByRole("region", { name: "榜单线索判断" });
    await expect(section.getByText("测试热点")).toBeVisible();
    await expect(section.getByText("其他线索")).toHaveCount(0);
    await expect(page.getByText("测试热点")).toHaveCount(2);
    await expect(page.getByText("A｜优先关注")).toHaveCount(2);
    await expect(page.getByText("B｜待看原文")).toHaveCount(1);
    await expect(page.getByText("普通内容")).toHaveCount(1);
    await section.getByText("判断理由与提示").click();
    await expect(section.getByText("待核实")).toBeVisible();
  } finally { await page.close(); }
});

for (const [id, status, title] of [["fixture:pending", "判断中，原始榜单仍可查看。", "未判断标题"], ["fixture:failed", "判断失败，原始榜单仍可查看。", "失败榜单标题"]]) test(`${status} preserves the original list`, async () => {
  const page = await browser.newPage();
  try {
    await visit(page, `${web.origin}/rankings?board=${encodeURIComponent(id!)}`);
    await expect(page.getByText(status!)).toBeVisible();
    await expect(page.getByText(title!)).toBeVisible();
    await expect(page.getByText("本次未识别到直接相关内容。")).toHaveCount(0);
  } finally { await page.close(); }
});

for (const width of [393, 1200]) test(`radar groups only matching A judgements at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  try {
    await visit(page, `${web.origin}/rankings`);
    const card = page.getByRole("region", { name: "豚榜 · 全网热搜总榜" });
    await expect(card.getByRole("link", { name: "测试热点" })).toHaveAttribute("href", "/items/matched");
    await expect(card.getByText("等待外部获取正文")).toBeVisible();
    await expect(card.getByText("其他线索")).toHaveCount(0);
    await expect(page.getByText("未判断标题")).toHaveCount(0);
    await card.getByRole("link", { name: "查看完整榜单 →" }).click();
    await expect(page).toHaveURL(/board=tunbang/);
    await expect(page.getByText("其他线索")).toBeVisible();
  } finally { await page.close(); }
});

for (const width of [393, 1200]) test(`radar history filters and preserves saved judgments at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  try {
    await visit(page, `${web.origin}/rankings?board=family%3Aradar`);
    await page.getByRole("link", { name: "历史记录" }).click();
    await expect(page.getByRole("region", { name: "热文雷达历史记录" })).toBeVisible();
    await page.getByLabel("采集日期").fill("2026-11-19");
    await expect(page).toHaveURL(/date=2026-11-19/);
    await page.getByLabel("历史来源").selectOption("豚榜");
    await page.getByLabel("历史榜单").selectOption("tunbang:all");
    await expect(page.getByRole("link", { name: "历史热点" })).toHaveAttribute("href", "/items/history");
    await page.getByText("查看上榜与判断记录").click();
    await expect(page.getByText("当时的判断")).toBeVisible();
    await page.getByRole("link", { name: "下一页" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText("第二页热点")).toBeVisible();
    await expect(page.getByLabel("历史来源")).toHaveValue("豚榜");
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    if (size.scroll > size.width + 1) throw new Error(`page overflows: ${size.scroll} > ${size.width}`);
    await page.getByRole("link", { name: "最新", exact: true }).click();
    await expect(page.getByText("测试热点")).toBeVisible();
  } finally { await page.close(); }
});
