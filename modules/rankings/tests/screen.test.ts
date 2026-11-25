import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { pointModels, stub } from "../../../tests/setup.ts";
import { sql } from "@aihot/backend/db";
import { screenRankings } from "../backend/screen.ts";

let malformed = false;
const provider = await stub((_hit, req) => {
  const request = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const input = JSON.parse(request.messages.at(-1)!.content) as { board_name: string; source: string; board_updated_at: string | null; fetched_at: string; items: Array<{ rank: number; title: string }> };
  const answer = { board_name: input.board_name, source: input.source, board_updated_at: input.board_updated_at, fetched_at: input.fetched_at,
    results: input.items.map((item, i) => ({ rank: malformed ? item.rank + 1 : item.rank, level: i ? "B" : "A", reason: "需查看", caution: "待核实", related_ranks: [] })) };
  return { id: "ranking-fixture", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
pointModels(provider.url);
after(async () => { await provider.close(); await sql.end(); });

test("snapshot screening saves valid results and leaves invalid output as failed", async () => {
  const items = [{ rank: 1, title: "学校\u00a0调整到校时间", url: null, heat: "", origin: "" }];
  const [first] = await sql<{ id: number }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt)
    VALUES ('screen-test','测试榜','测试来源','https://example.com',${sql.json(items)},now(),'test-v1','判断') RETURNING id`;
  assert.deepEqual(await screenRankings(), { processed: 1 });
  const [saved] = await sql`SELECT status,results,receipt_id FROM external_ranking_snapshots WHERE id=${first!.id}`;
  assert.equal(saved!.status, "complete");
  assert.equal(saved!.results[0].level, "A");
  assert.equal(saved!.results[0].title, items[0]!.title);
  assert.ok(saved!.receipt_id);

  malformed = true;
  const [second] = await sql<{ id: number }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt)
    VALUES ('screen-test','测试榜','测试来源','https://example.com',${sql.json(items)},now()+interval '1 second','test-v2','判断') RETURNING id`;
  assert.deepEqual(await screenRankings(), { processed: 0 });
  const [failed] = await sql`SELECT status,results FROM external_ranking_snapshots WHERE id=${second!.id}`;
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.results, null);
});

test('completed screening records new A-level article tasks atomically', async () => {
  malformed = false;
  await sql`INSERT INTO radar_body_activation(id,activated_at) VALUES (true,now()-interval '1 day') ON CONFLICT(id) DO UPDATE SET activated_at=excluded.activated_at`;
  const items = [{ rank: 1, title: '雷达文章', url: 'https://example.org/radar-article', heat: '', origin: '测试来源' }];
  const [snapshot] = await sql<{ id: number }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt)
    VALUES ('screen-task','测试榜','测试来源','https://example.org',${sql.json(items)},now(),'test-v1','判断') RETURNING id`;
  assert.deepEqual(await screenRankings(), { processed: 1 });
  const [task] = await sql`SELECT t.state,a.url FROM radar_body_occurrences o JOIN radar_body_tasks t ON t.id=o.task_id JOIN articles a ON a.id=t.article_id WHERE o.snapshot_id=${snapshot!.id}`;
  assert.equal(task!.state, 'pending');
  assert.equal(task!.url, items[0]!.url);
});


test("identical snapshots reuse only matching screening configuration and retain occurrences", async () => {
  malformed = false;
  const items = [{ rank: 1, title: "重复的教育线索", url: "https://example.org/reused", heat: "", origin: "测试" }];
  const make = async (rule: string, data = items) => (await sql<{ id: number }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt)
    VALUES ('screen-reuse','复用榜','来源','https://example.org',${sql.json(data)},clock_timestamp(),${rule},'判断') RETURNING id`)[0]!.id;
  const first = await make('v1');
  const before = provider.hits();
  await screenRankings();
  const second = await make('v1');
  await screenRankings();
  assert.equal(provider.hits(), before + 1);
  const rows = await sql`SELECT id,status,receipt_id,screen_signature,results FROM external_ranking_snapshots WHERE id IN (${first},${second}) ORDER BY id`;
  assert.equal(rows[1]!.status, 'complete');
  assert.equal(rows[1]!.receipt_id, rows[0]!.receipt_id);
  assert.deepEqual(rows[1]!.results, rows[0]!.results);
  assert.equal((await sql`SELECT snapshot_id FROM radar_body_occurrences WHERE snapshot_id IN (${first},${second})`).length, 2);
  await make('v2');
  await screenRankings();
  assert.equal(provider.hits(), before + 2, 'a changed rule must be judged again');
  await make('v1', [{ ...items[0]!, title: '变化的教育线索' }]);
  await screenRankings();
  assert.equal(provider.hits(), before + 3, 'changed content must be judged again');
  const originalEndpoint = process.env.DASHSCOPE_BASE_URL;
  try {
    process.env.DASHSCOPE_BASE_URL = `${provider.url}/changed`;
    await make('v1');
    await screenRankings();
    assert.equal(provider.hits(), before + 4, 'a changed endpoint must be judged again');
  } finally {
    process.env.DASHSCOPE_BASE_URL = originalEndpoint;
  }
});
