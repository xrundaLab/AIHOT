import type { ReportCitation } from "@aihot/contracts/site";
import { loadItemDetail } from "./detail.ts";
import { dailyUrl, itemUrl, siteUrl } from "./links.ts";
import { loadReport } from "./reports.ts";

const plain = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]<>]/g, "\\$&");
const link = (value: string) => {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "未提供";
    return `<${url.href.replace(/[<>]/g, encodeURIComponent)}>`;
  } catch {
    return "未提供";
  }
};
const state = (value?: boolean | null) => value == null ? "未知" : value ? "是" : "否";

export async function dailyMarkdown(date: string): Promise<string | null> {
  const report = await loadReport("daily", date);
  if (!report) return null;
  const metadata = new Map<string, ReturnType<typeof loadItemDetail>>();
  async function citation(article: ReportCitation, depth: number): Promise<string> {
    if (!article.available) return "";
    const id = article.itemId;
    if (id && !metadata.has(id)) metadata.set(id, loadItemDetail(id));
    const detail = id ? await metadata.get(id) : null;
    if (detail?.kind === "not_found") return "";
    const item = detail?.kind === "found" ? detail.item : null;
    const status = article.dailyStatus;
    const lines = [
      `${"#".repeat(depth)} ${plain(article.title)}`,
      "",
      `- 来源：${plain(article.sourceName)}`,
      `- 站内文章：${id ? link(itemUrl(encodeURIComponent(id))) : "未提供"}`,
      `- 原文：${link(article.sourceUrl)}`,
      `- 发布时间：${article.publishedAt ?? "未知"}`,
      `- 精选：${state(status?.selected)}`,
      `- 热点：${state(status?.hot)}`,
      `- 热文雷达：${state(status?.fromRadar)}`,
      `- AI 评分：${status?.score ?? "未知"}`,
      `- 标签（当前文章）：${item?.tags.map(plain).join("、") || (item ? "无" : "未知")}`,
      `- 主题（当前文章）：${item?.topics.map(topic => `${plain(topic.name)} ${link(siteUrl(`/topics/${encodeURIComponent(topic.slug)}`))}`).join("、") || (item ? "无" : "未知")}`,
      "",
    ];
    if (article.summary) lines.push(plain(article.summary), "");
    for (const related of article.related ?? []) {
      const rendered = await citation(related, Math.min(depth + 1, 6));
      if (rendered) lines.push(rendered);
    }
    return lines.join("\n");
  }

  const lines = [
    `# ${plain(report.title)}`, "",
    `- 日报日期：${report.key}`,
    `- 期号：${report.issueNumber}`,
    `- 生成时间：${report.generatedAt}`,
    `- 日报链接：${link(dailyUrl(report.key))}`, "",
  ];
  if (report.lead) lines.push("## 头条", "", plain(report.lead.title), "", plain(report.lead.leadParagraph), "");
  for (const section of [...report.sections, { label: "快讯", summary: null, items: report.flashes }]) {
    if (!section.items.length) continue;
    lines.push(`## ${plain(section.label)}`, "");
    if (section.summary) lines.push(plain(section.summary), "");
    for (const article of section.items) {
      const rendered = await citation(article, 3);
      if (rendered) lines.push(rendered);
    }
  }
  return lines.join("\n");
}
