import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import { fakeApi, feedItem, startWebServer, visit, type WebServer } from "./web-server.ts";

const at = "2026-11-19T08:00:00Z";
let web: WebServer; let browser: Browser;
before(async () => {
  web = await startWebServer(fakeApi(url => {
    if (url.pathname === "/api/admin/me") return { name: "管理员", csrf: "test-csrf", dev: true };
    if (url.pathname === "/api/admin/nav-counts") return {};
    if (url.pathname === "/api/admin/radar") return { source: { id: "radar-discovery", participation_mode: "isolated", tier: "T2", updated_at: at, enabled: true }, counts: [{ state: "external", count: 1 }], tasks: [{ id: "1", title: "需补采文章", url: "https://example.org/test", origin: "来源", state: "external", error: "抓取失败", article_id: "radar-article", processing_state: "skipped", visibility: null }] };
    if (url.pathname !== "/api/site/pool") return;
    const collection = url.searchParams.get("collection");
    return { filters: { channel: "all", category: url.searchParams.get("category"), tag: url.searchParams.get("tag"), q: url.searchParams.get("q"), tab: "time", sort: url.searchParams.get("sort") === "published" ? "published" : "collected", collection },
      items: [feedItem({ id: "radar-article", title: "雷达文章", badge: "热文雷达", discoveredAt: at, publishedAt: at })], page: 1, pageCount: 1, total: 1, todayCount: 1, freshness: at };
  }));
  browser = await chromium.launch({ channel: "chromium" });
});
after(async () => { await browser?.close(); await web?.stop(); });
for (const width of [393, 1200]) test(`radar is a peer filter and preserves sorting at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  try {
    await visit(page, `${web.origin}/all?sort=published&tag=source%3Awechat-share`);
    if (width < 961) {
      await page.getByRole("button", { name: /筛选/ }).click();
      const sheet = page.getByRole("dialog", { name: "筛选" });
      await expect(sheet.getByRole("link", { name: "我 AI 我家" })).toBeVisible();
      await sheet.getByRole("link", { name: "热文雷达" }).click();
    } else {
      const filters = page.getByRole("navigation", { name: "筛选" });
      const names = await filters.getByRole("link").allTextContents();
      expect(names.indexOf("热文雷达")).toBe(names.indexOf("我 AI 我家") + 1);
      await filters.getByRole("link", { name: "热文雷达" }).click();
    }
    await expect(page).toHaveURL(/collection=radar/);
    await expect(page).toHaveURL(/sort=published/);
    await expect(page).not.toHaveURL(/wechat-share/);
    await expect(page.locator('article[data-item-id="radar-article"]').getByText("热文雷达")).toBeVisible();
    await page.reload();
    if (width < 961) {
      await expect(page.getByRole("link", { name: "取消筛选：热文雷达" })).toBeVisible();
      await page.getByRole("button", { name: /筛选/ }).click();
      await page.getByRole("dialog", { name: "筛选" }).getByRole("link", { name: "政策" }).click();
    } else {
      const filters = page.getByRole("navigation", { name: "筛选" });
      await expect(filters.getByRole("link", { name: "热文雷达" })).toHaveAttribute("aria-current", "page");
      await filters.getByRole("link", { name: "政策" }).click();
    }
    await expect(page).toHaveURL(/category=policy/);
    await expect(page).not.toHaveURL(/collection=radar/);
    await expect(page).toHaveURL(/sort=published/);
  } finally { await page.close(); }
});

test("radar admin exposes publishing state and task controls", async () => {
  const page = await browser.newPage();
  try {
    await visit(page, `${web.origin}/admin/radar`);
    await expect(page.getByRole("heading", { name: "热文雷达" })).toBeVisible();
    await expect(page.getByRole("button", { name: "开启自动发布" })).toBeVisible();
    let update: { patch?: { participation_mode?: string; tier?: string } } | undefined;
    await page.route("**/api/admin/sources/radar-discovery", async route => {
      update = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true } });
    });
    await page.getByRole("button", { name: "开启自动发布" }).click();
    await expect.poll(() => update?.patch?.participation_mode).toBe("editorial");
    await expect.poll(() => update?.patch?.tier).toBe("EXCLUDE_MP");
    await expect(page.getByRole("link", { name: "需补采文章" })).toHaveAttribute("href", "/admin/content/radar-article");
    await expect(page.getByRole("button", { name: "重试抓取" })).toBeVisible();
  } finally { await page.close(); }
});
