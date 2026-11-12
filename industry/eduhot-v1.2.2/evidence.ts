import { readFileSync } from "node:fs";

type Label = { tag: string; quote: string };
const standard = JSON.parse(readFileSync(new URL("./standard.json", import.meta.url), "utf8")) as {
  matchingTags: { id: string; name: string }[];
  detailTags: { name: string }[];
};
const matching = new Set(standard.matchingTags.map((entry) => entry.name));
const matchingNames = new Map(standard.matchingTags.map((entry) => [entry.id, entry.name]));
const details = new Set(standard.detailTags.map((entry) => entry.name));
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();

/** Accept only allowed labels with quotes present in both the original and the model input. */
export function groundedLabels(result: { matchingTags: Label[]; detailTags: Label[] }, original: string | readonly string[], visible: string) {
  const sources = (typeof original === "string" ? [original] : original).map(normalize);
  const input = normalize(visible);
  const select = (entries: Label[], allowed: Set<string>, aliases: ReadonlyMap<string, string> = new Map()) => {
    const seen = new Set<string>();
    return entries.flatMap(({ tag, quote }) => {
      const evidence = normalize(quote);
      const name = aliases.get(tag.trim()) ?? tag.trim();
      if (!allowed.has(name) || seen.has(name) || !evidence || !sources.some((source) => source.includes(evidence)) || !input.includes(evidence)) return [];
      seen.add(name);
      return [{ tag: name, quote: evidence }];
    });
  };
  return { matchingTags: select(result.matchingTags, matching, matchingNames), detailTags: select(result.detailTags, details) };
}
