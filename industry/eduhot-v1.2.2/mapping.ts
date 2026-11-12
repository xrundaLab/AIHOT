import { readFileSync } from "node:fs";

interface Standard {
  topics: { id: string }[];
  matchingTags: { name: string; topic: string }[];
}

const standard = JSON.parse(readFileSync(new URL("./standard.json", import.meta.url), "utf8")) as Standard;
const tagToTopic = new Map(standard.matchingTags.map((tag) => [tag.name, tag.topic]));

/** Only the separately supplied matching tags may select topics. */
export function mapTopics(matchingTags: readonly string[], _detailTags: readonly string[]): string[] {
  const matched = new Set<string>();
  for (const tag of matchingTags) {
    const topic = tagToTopic.get(tag);
    if (!topic) throw new Error(`未知主题匹配标签: ${tag}`);
    matched.add(topic);
  }
  return standard.topics.map((topic) => topic.id).filter((id) => matched.has(id));
}

/** Compare the full supported set with the current three-tag production constraint. */
export function compareTopThree(matchingTags: readonly string[]) {
  const allTopics = mapTopics(matchingTags, []);
  const retainedTags = [...new Set(matchingTags)].slice(0, 3);
  const retainedTopics = mapTopics(retainedTags, []);
  const retained = new Set(retainedTopics);
  return { allTopics, retainedTags, retainedTopics, lostTopics: allTopics.filter((id) => !retained.has(id)) };
}
