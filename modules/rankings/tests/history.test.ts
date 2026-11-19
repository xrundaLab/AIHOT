import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { sql } from "@aihot/backend/db";
import { loadRadarHistory, validHistoryDate } from "../backend/history.ts";

after(async () => { await sql.end(); });
const judgment = (rank: number, title: string, level: "A" | "B" = "A", reason = "当时判断") => ({ rank,title,level,reason,caution:"待核实",related_ranks:[] });
const item = (rank: number, title: string, url: string | null) => ({ rank,title,url,heat:"",origin:"来源",raw:{ secret:"private" } });
async function snapshot(board: string, source: string, when: string, items: ReturnType<typeof item>[], results: ReturnType<typeof judgment>[], status = "complete") {
  await sql`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,results,status,fetched_at,rule_version,rule_prompt)
    VALUES (${board},${board},${source},'https://example.org',${sql.json(items)},${sql.json(results)},${status},${new Date(when)},'v1','private prompt')`;
}
test("history keeps each day's saved A judgments, merges a URL and respects Beijing midnight", async () => {
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES ('history-source','来源','rss','editorial')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES ('history-a','history-source','url:https://example.org/a','https://example.org/a','文章',now(),now())`;
  await sql`INSERT INTO publications(article_id,source_id,title,url,channel,visibility,eligible,discovered_at,timeline_at,sort_at) VALUES ('history-a','history-source','文章','https://example.org/a','news','public',true,now(),now(),now())`;
  await snapshot('board-1','豚榜','2026-11-18T16:01:00Z',[item(1,'旧标题','https://example.org/a'),item(2,'无链接',null),item(3,'B级','https://example.org/b')],[judgment(1,'旧标题','A','旧理由'),judgment(2,'无链接'),judgment(3,'B级','B')]);
  await snapshot('board-2','微小榜','2026-11-19T15:59:00Z',[item(7,'新标题','https://example.org/a?utm_source=feed'),item(8,'不匹配','https://example.org/c')],[judgment(7,'新标题','A','新理由'),judgment(8,'错误标题')]);
  await snapshot('next','豚榜','2026-11-19T16:00:00Z',[item(1,'次日','https://example.org/next')],[judgment(1,'次日')]);
  await snapshot('pending','豚榜','2026-11-19T12:00:00Z',[item(1,'未完成','https://example.org/p')],[judgment(1,'未完成')], 'pending');
  const all = await loadRadarHistory('2026-11-19',null,null,1);
  assert.equal(all.total, 2);
  assert.equal(all.items[0]!.title, '新标题');
  assert.equal(all.items[0]!.occurrences.length, 2);
  assert.deepEqual(all.items[0]!.occurrences.map(o => o.judgement.reason), ['新理由','旧理由']);
  assert.equal(all.items[0]!.firstAt, '2026-11-18T16:01:00.000Z');
  assert.equal(all.items[0]!.lastAt, '2026-11-19T15:59:00.000Z');
  assert.equal(all.items[0]!.detailUrl, '/items/history-a', 'a matching older occurrence can provide the public detail');
  assert.ok(!JSON.stringify(all).includes('private'));
  const source = await loadRadarHistory('2026-11-19','豚榜','board-1',1);
  assert.equal(source.total, 2);
  assert.equal(source.items[0]!.detailUrl, '/items/history-a');
  assert.equal((await loadRadarHistory('2026-11-20',null,null,1)).items[0]!.title, '次日');
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id='history-a'`;
  assert.deepEqual((await loadRadarHistory('2026-11-19','豚榜','board-1',1)).items.map(x => x.title), ['无链接']);
});
test("validates calendar dates and paginates history", async () => {
  assert.equal(validHistoryDate('2026-02-29'), false);
  assert.equal(validHistoryDate('2024-02-29'), true);
  const items = Array.from({length: 35}, (_, i) => item(i+1, `标题${i}`, `https://example.org/${i}`));
  await snapshot('many','测试','2026-11-21T00:00:00Z',items,items.map(x => judgment(x.rank,x.title)));
  const page = await loadRadarHistory('2026-11-21',null,null,2);
  assert.deepEqual([page.total,page.page,page.pageCount,page.items.length], [35,2,2,5]);
});

test("history endpoint validates dates and pagination", async () => {
  const { default: Fastify } = await import("fastify");
  const { rankingsServer } = await import("../server.ts");
  const app = Fastify(); rankingsServer.http!(app);
  try {
    assert.equal((await app.inject({ url: '/api/site/rankings/history?date=2026-02-29' })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/site/rankings/history?date=2026-11-19&page=-1' })).statusCode, 400);
    const res = await app.inject({ url: '/api/site/rankings/history?date=2026-11-19&source=%E8%B1%9A%E6%A6%9C' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().source, '豚榜');
    assert.equal(res.headers['cache-control'], 'public, max-age=60');
  } finally { await app.close(); }
});
