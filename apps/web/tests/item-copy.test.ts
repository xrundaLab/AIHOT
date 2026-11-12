// Failure mode: WeChat's in-app browser cannot save downloads, so the article offers "复制 Markdown" there
// instead; it copied with the async clipboard, which that browser does not have, and always failed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { fakeApi, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

const markdown = "# 复制检查\n\n固定正文";

test("in WeChat, 复制 Markdown copies the article without the async clipboard", async () => {
  const api = fakeApi((url, res) => {
    if (url.pathname === "/api/site/items/wechat-copy") return itemDetail({ id: "wechat-copy", title: "复制检查" });
    if (url.pathname === "/items/wechat-copy/markdown") {
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      return res.end(markdown);
    }
  });
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50",
    });
    // As in WeChat: no async clipboard; a selection copy works, and what it copied is kept for the test.
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
      document.execCommand = (command: string) => {
        if (command !== "copy") return false;
        (window as { copied?: string }).copied = (document.activeElement as HTMLTextAreaElement | null)?.value;
        return true;
      };
    });
    const page = await context.newPage();
    await visit(page, web.origin + "/items/wechat-copy");
    await page.getByRole("button", { name: "更多操作" }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "复制 Markdown" }).click();
    await expect(page.getByRole("status")).toHaveText("Markdown 已复制");
    assert.equal(await page.evaluate(() => (window as { copied?: string }).copied), markdown);
  } finally {
    await browser.close();
    await web?.stop();
  }
});

test("article evaluation records a vote before an optional note on desktop and mobile", async () => {
  const requests: Array<{ method: string; body: unknown }> = [];
  const api = fakeApi(async (url, _res, req) => {
    if (url.pathname === "/api/site/items/review-item") return itemDetail({ id: "review-item", title: "评价检查", scoreAnalyzedAt: "2026-10-04T08:00:00.000Z" });
    if (url.pathname.startsWith("/api/site/items/review-item/reviews")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ method: req.method!, body: JSON.parse(Buffer.concat(chunks).toString()) });
      return { id: "test-review", ok: true };
    }
  });
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    for (const width of [1366, 393]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await visit(page, web.origin + "/items/review-item");
      await page.getByRole("button", { name: "评价为赞" }).filter({ visible: true }).click();
      await expect(page.getByRole("dialog", { name: "添加评价备注" })).toBeVisible();
      assert.deepEqual(requests.at(-1), { method: "POST", body: { vote: "up" } });
      await page.getByLabel("备注（选填）").fill("有帮助");
      await page.getByRole("button", { name: "提交备注" }).click();
      await expect(page.getByText("评价和备注已记录")).toBeVisible();
      assert.deepEqual(requests.at(-1), { method: "PATCH", body: { note: "有帮助" } });
      await page.getByRole("button", { name: "评价为踩" }).filter({ visible: true }).click();
      await expect(page.getByRole("dialog", { name: "添加评价备注" })).toBeVisible();
      await page.keyboard.press("Escape");
      assert.deepEqual(requests.at(-1), { method: "POST", body: { vote: "down" } });
      await page.close();
    }
  } finally {
    await browser.close();
    await web?.stop();
  }
});

test("topic matching labels appear separately on desktop and mobile", async () => {
  const api = fakeApi((url) => url.pathname === "/api/site/items/topic-labels" ? itemDetail({
    id: "topic-labels", title: "主题匹配标签检查", tags: ["平台规则"],
    topics: [{ slug: "v122-b4", name: "家庭数字安全与权益" }],
    topicMatches: [{ tag: "家庭平台权益", topic: { slug: "v122-b4", name: "家庭数字安全与权益" } }],
  }) : undefined);
  const browser = await chromium.launch({ channel: "chromium" });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    for (const width of [1366, 393]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await visit(page, web.origin + "/items/topic-labels");
      const label = page.getByRole("link", { name: "#家庭平台权益" }).filter({ visible: true });
      await expect(label).toBeVisible();
      await expect(label).toHaveAttribute("href", "/topics/v122-b4");
      await expect(page.getByRole("link", { name: "#平台规则" }).filter({ visible: true })).toBeVisible();
      await page.close();
    }
  } finally {
    await browser.close();
    await web?.stop();
  }
});
