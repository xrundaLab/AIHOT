import { readFileSync } from "node:fs";

interface Standard {
  categories: string[][];
  matchingTags: { id: string; name: string; include: string; exclude: string }[];
  detailTags: { name: string; include: string; exclude: string; note: string }[];
}

/** Render the isolated trial prompt from the reviewed workbook dictionary. */
export function buildPrompt(): string {
  const standard = JSON.parse(readFileSync(new URL("./standard.json", import.meta.url), "utf8")) as Standard;
  const template = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");
  const categories = standard.categories.map(([label, key, definition, , exclude]) => `- ${key}（${label}）：${definition}；排除：${exclude}`).join("\n");
  const matchingTags = standard.matchingTags.map((tag) => `- ${tag.id} ${tag.name}：${tag.include}；排除：${tag.exclude}`).join("\n");
  const detailTags = standard.detailTags.map((tag) => `- ${tag.name}：${tag.include}；排除：${tag.exclude}；${tag.note}`).join("\n");
  return template.replace("{{categories}}", `\n${categories}`).replace("{{matchingTags}}", `\n${matchingTags}`).replace("{{detailTags}}", `\n${detailTags}`);
}
