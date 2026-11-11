import { test } from "node:test";
import assert from "node:assert/strict";
import { isListedByDate, isPoolEligible, isSelectable } from "@aihot/backend/publication/rules";

test("an editorial override can list an undated historical item without selecting it", () => {
  const date = { backfill: true, publishedAt: null };
  const content = isPoolEligible({ participationMode: "editorial", relevance: "pass", title: "标题", summary: "摘要" });
  const normal = isListedByDate({ ...date, listUndated: false });
  assert.equal(normal, false);
  assert.equal(isListedByDate({ ...date, listUndated: true }), true);
  assert.equal(content && isListedByDate({ ...date, listUndated: true }), true);
  assert.equal(isSelectable(content && normal, true, "T1"), false);
  assert.equal(isPoolEligible({ participationMode: "editorial", relevance: "block", title: "标题", summary: "摘要" }), false);
});
