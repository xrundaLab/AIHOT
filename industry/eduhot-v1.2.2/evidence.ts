import { readFileSync } from "node:fs";

type Label = { tag: string; quote: string };
const standard = JSON.parse(readFileSync(new URL("./standard.json", import.meta.url), "utf8")) as {
  matchingTags: { name: string }[];
  detailTags: { name: string }[];
};
const matching = new Set(standard.matchingTags.map((entry) => entry.name));
const details = new Set(standard.detailTags.map((entry) => entry.name));
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();

/** Accept only allowed labels with quotes present in both the original and the model input. */
export function groundedLabels(result: { matchingTags: Label[]; detailTags: Label[] }, original: string | readonly string[], visible: string) {
  const sources = (typeof original === "string" ? [original] : original).map(normalize);
  const input = normalize(visible);
  const select = (entries: Label[], allowed: Set<string>) => {
    const seen = new Set<string>();
    return entries.flatMap(({ tag, quote }) => {
      const evidence = normalize(quote);
      if (!allowed.has(tag) || seen.has(tag) || !evidence || !sources.some((source) => source.includes(evidence)) || !input.includes(evidence)) return [];
      seen.add(tag);
      return [{ tag, quote: evidence }];
    });
  };
  return { matchingTags: select(result.matchingTags, matching), detailTags: select(result.detailTags, details) };
}
