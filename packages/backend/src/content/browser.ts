// Render public pages without allowing the browser to connect around the guarded HTTP fetcher.
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { guardedFetch, languageHeaders } from "../lib/http-fetch.ts";
import { isSignInRedirect } from "./extract.ts";

const MAX_REQUESTS = 60;
const MAX_BYTES = 12 * 1024 * 1024;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  else active++;
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

/** Every document, script and XHR is fetched by guardedFetch, including redirects and DNS checks. */
export async function renderArticle(url: string, language?: string): Promise<{ html: string; url: string } | null> {
  if (process.env.BROWSER_RENDER_ENABLED !== "true") return null;
  await acquire();
  try {
    const initial = await guardedFetch(url, { headers: languageHeaders(language), timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    if (initial.status !== 200 || !/html/i.test(initial.headers.get("content-type") ?? "") || isSignInRedirect(url, initial.url)) return null;
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND", "--disable-quic", "--disable-features=WebRtcHideLocalIpsWithMdns", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
    const deadline = setTimeout(() => { void browser.close().catch(() => {}); }, 30_000);
    try {
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        let requests = 0, bytes = 0, first = true;
        await context.routeWebSocket("**/*", socket => socket.close());
        await context.route("**/*", async route => {
          const request = route.request();
          if (++requests > MAX_REQUESTS || request.method() !== "GET" || ["image", "media", "font"].includes(request.resourceType())) return route.abort();
          try {
            const response = first && request.isNavigationRequest() && request.url() === initial.url
              ? (first = false, initial)
              : await guardedFetch(request.url(), { headers: languageHeaders(language), timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 });
            bytes += response.body.length;
            if (bytes > MAX_BYTES || (request.isNavigationRequest() && isSignInRedirect(url, response.url))) return route.abort();
            // A decoded response must not carry the upstream compression or length headers.
            const headers: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/octet-stream" };
            for (const name of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-expose-headers"]) {
              const value = response.headers.get(name);
              if (value) headers[name] = value;
            }
            await route.fulfill({ status: response.status, headers, body: response.body });
          } catch { await route.abort().catch(() => {}); }
        });
        const page = await context.newPage();
        const response = await page.goto(initial.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        if (!response || response.status() !== 200 || isSignInRedirect(url, page.url())) return null;
        await page.waitForTimeout(1000);
        const html = await page.content();
        if (Buffer.byteLength(html) > 6 * 1024 * 1024) return null;
        return { html, url: page.url() };
      } finally { await context.close(); }
    } finally { clearTimeout(deadline); await browser.close(); }
  } finally { release(); }
}
