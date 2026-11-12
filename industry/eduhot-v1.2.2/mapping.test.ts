import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mapTopics, compareTopThree } from "./mapping.ts";

test("主题由匹配标签独立触发，细标签不能触发", () => {
  assert.deepEqual(mapTopics([], ["学习方法", "未成年人保护"]), []);
  assert.deepEqual(mapTopics(["青少年AI使用", "家长AI应用"], ["学习方法"]), ["A3", "B1"]);
});

test("保留所有主题并报告三标签截断导致的主题损失", () => {
  assert.deepEqual(compareTopThree(["AI课堂", "AI辅助学习", "青少年AI使用", "家长AI应用"]), {
    allTopics: ["A1", "A2", "A3", "B1"],
    retainedTags: ["AI课堂", "AI辅助学习", "青少年AI使用"],
    retainedTopics: ["A1", "A2", "A3"],
    lostTopics: ["B1"],
  });
});

test("未知匹配标签不应静默丢弃", () => {
  assert.throws(() => mapTopics(["不存在的标签"], []), /不存在的标签/);
});

test("字典与主题映射完整且没有细标签交叉", async () => {
  const { readFileSync } = await import("node:fs");
  const standard = JSON.parse(readFileSync(new URL("./standard.json", import.meta.url), "utf8"));
  assert.equal(standard.topics.length, 13);
  assert.equal(standard.matchingTags.length, 52);
  assert.equal(standard.detailTags.length, 40);
  assert.equal(standard.categories.length, 7);
  assert.equal(new Set(standard.matchingTags.map((t: { name: string }) => t.name)).size, 52);
  for (const tag of standard.matchingTags) assert.deepEqual(mapTopics([tag.name], []), [tag.topic]);
  for (const tag of standard.detailTags) assert.deepEqual(mapTopics([], [tag.name]), []);
});

test("试跑提示词展开完整字典", async () => {
  const { buildPrompt } = await import("./prompt.ts");
  const prompt = buildPrompt();
  assert.match(prompt, /家庭平台权益/);
  assert.match(prompt, /编辑资料检索/);
  assert.match(prompt, /探索线索/);
  assert.doesNotMatch(prompt, /\{\{(?:categories|matchingTags|detailTags)\}\}/);
});

test("试跑标签必须具有模型可见的原文证据，且两种标签分别保存", async () => {
  const { groundedLabels } = await import("./evidence.ts");
  const output = groundedLabels({
    matchingTags: [
      { tag: "青少年AI使用", quote: "学生使用AI练习" },
      { tag: "家长AI应用", quote: "家长使用AI" },
      { tag: "AI辅助学习", quote: "未发送的后文" },
    ],
    detailTags: [{ tag: "学生", quote: "学生使用AI练习" }, { tag: "未成年人保护", quote: "不存在的内容" }],
  }, "学生使用AI练习。未发送的后文", "学生使用AI练习。");
  assert.deepEqual(output, {
    matchingTags: [{ tag: "青少年AI使用", quote: "学生使用AI练习" }],
    detailTags: [{ tag: "学生", quote: "学生使用AI练习" }],
  });
  assert.deepEqual(groundedLabels({ matchingTags: [{ tag: "AI课堂", quote: "前句 后句" }], detailTags: [] }, ["前句", "后句"], "前句 后句").matchingTags, []);
});

test("模型返回匹配标签编号时按字典转换，保留原文证据并按名称去重", async () => {
  const { groundedLabels } = await import("./evidence.ts");
  assert.deepEqual(groundedLabels({ matchingTags: [{ tag: "N035", quote: "开源项目可用于学习" }], detailTags: [] }, "开源项目可用于学习", "开源项目可用于学习").matchingTags, [{ tag: "开源AI应用", quote: "开源项目可用于学习" }]);
  const result = groundedLabels({
    matchingTags: [
      { tag: "N035", quote: "开源项目可用于学习" },
      { tag: "开源AI应用", quote: "开源项目可用于学习" },
      { tag: "N031", quote: "原文不存在" },
      { tag: "N999", quote: "开源项目可用于学习" },
    ],
    detailTags: [{ tag: "N035", quote: "开源项目可用于学习" }],
  }, "开源项目可用于学习", "开源项目可用于学习");
  assert.deepEqual(result, { matchingTags: [{ tag: "开源AI应用", quote: "开源项目可用于学习" }], detailTags: [] });
  assert.deepEqual(mapTopics(result.matchingTags.map(item => item.tag), []), ["C1"]);
});
