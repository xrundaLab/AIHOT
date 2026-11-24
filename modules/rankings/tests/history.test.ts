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
  await sql`INSERT INTO publications(article_id,source_id,title,url,channel,visibility,eligible,discovered_at,timeline_at,sort_at) VALUES ('history-a','history-source','文章','https://example.org/a','news','public',false,now(),now(),now())`;
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

import { radarDailyCandidates } from "../backend/publication.ts";

test("daily radar candidates use in-window completed A snapshots and public article associations", async () => {
  const from = new Date('2026-11-23T00:00:00Z'), to = new Date('2026-11-24T00:00:00Z');
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES ('daily-radar-source','radar article source','rss','editorial')`;
  const article = async (id: string, visibility = 'public') => {
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,body_status,body_text)
      VALUES(${id},'daily-radar-source',${id},${`https://example.org/${id}`},${id},${from},${from},'ok','confirmed article body')`;
    await sql`INSERT INTO publications(article_id,source_id,title,summary,url,channel,visibility,eligible,selected,discovered_at,timeline_at,sort_at)
      VALUES(${id},'daily-radar-source',${id},'family summary',${`https://example.org/${id}`},'news',${visibility},true,false,${from},${from},${from})`;
    const [task] = await sql`INSERT INTO radar_body_tasks(identity_key,article_id,title,url,origin,state)
      VALUES(${id},${id},${id},${`https://example.org/${id}`},'radar original','complete') RETURNING id`;
    return task!.id as number;
  };
  const a = await article('daily-radar-a');
  const b = await article('daily-radar-b');
  const withdrawn = await article('daily-radar-withdrawn', 'withdrawn');
  const occurrences = async (at: Date, status: string, rows: Array<{ id: string; task: number; level: 'A'|'B' }>) => {
    const entries = rows.map((r,i) => item(i+1,r.id,`https://example.org/${r.id}`));
    const [s] = await sql`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,results,status,fetched_at,rule_version,rule_prompt)
      VALUES('daily-radar-test','daily radar','test','https://example.org',${sql.json(entries)},${sql.json(rows.map((r,i) => judgment(i+1,r.id,r.level)))},${status},${at},'v1','test') RETURNING id`;
    for (let i=0; i<rows.length; i++) await sql`INSERT INTO radar_body_occurrences(snapshot_id,rank,task_id) VALUES(${s!.id},${i+1},${rows[i]!.task})`;
  };
  await occurrences(from,'complete',[{id:'daily-radar-a',task:a,level:'A'},{id:'daily-radar-b',task:b,level:'B'}, {id:'daily-radar-withdrawn',task:withdrawn,level:'A'}]);
  await occurrences(new Date(from.getTime()+1000),'complete',[{id:'daily-radar-a',task:a,level:'A'}]);
  const edge = await article('daily-radar-end');
  await occurrences(to,'complete',[{id:'daily-radar-end',task:edge,level:'A'}]);
  const pending = await article('daily-radar-pending');
  await occurrences(new Date(from.getTime()+2000),'pending',[{id:'daily-radar-pending',task:pending,level:'A'}]);
  const candidates = await radarDailyCandidates(from,to);
  assert.deepEqual(candidates.map(x=>x.articleId), ['daily-radar-a']);
  assert.equal(candidates[0]!.fromRadar,true);
  assert.equal(candidates[0]!.origin,'radar');
  assert.equal(candidates[0]!.observedAt,from.toISOString());
  const { dailyEdition } = await import("@aihot/backend/reports/edition");
  const { installModules, serverModules } = await import("@aihot/backend/modules");
  const { rankingsServer } = await import("../server.ts");
  const previous = serverModules();
  installModules([rankingsServer]);
  try {
    let edition = await dailyEdition('2026-11-24',from,to);
    assert.equal(edition.entries.length,1);
    assert.equal(edition.entries[0]!.entry.fromRadar,true);
    assert.deepEqual(edition.entries[0]!.entry.candidateOrigins,['radar']);
    await sql`UPDATE publications SET selected=true,visible_after=${from} WHERE article_id='daily-radar-a'`;
    edition = await dailyEdition('2026-11-24',from,to);
    assert.equal(edition.entries.length,1,'selection and radar converge before history suppression');
    assert.deepEqual(edition.entries[0]!.entry.candidateOrigins,['selected','radar']);
    assert.equal(edition.entries[0]!.entry.fromRadar,true);
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at)
      VALUES('daily','2026-11-23',${from},${from},${sql.json({sections:[{label:'news',items:[{itemId:'daily-radar-a'}]}]})},${from})`;
    assert.equal((await dailyEdition('2026-11-24',from,to)).entries.length,0,'previous daily removes the same article after all paths merge');
    await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES ('radar-discovery','热文雷达','external','editorial')
      ON CONFLICT(id) DO UPDATE SET participation_mode='editorial'`;
    await sql`UPDATE articles SET source_id='radar-discovery' WHERE id='daily-radar-a'`;
    await sql`UPDATE publications SET source_id='radar-discovery' WHERE article_id='daily-radar-a'`;
    await sql`UPDATE radar_body_tasks SET origin='知乎热榜' WHERE article_id='daily-radar-a'`;
    await sql`UPDATE reports SET content=${sql.json({ sections: [{ label: "资讯", items: [
      { itemId: "daily-radar-a", title: "旧日报文章", sourceName: "热文雷达", fromRadar: true },
      { itemId: "daily-radar-b", title: "已有信源", sourceName: "热文雷达", fromRadar: true },
    ] }] })} WHERE kind='daily' AND key='2026-11-23'`;
    const { v1Daily } = await import("@aihot/backend/publication/reports");
    const { dailyMarkdown } = await import("@aihot/backend/publication/daily-markdown");
    const output = await v1Daily("2026-11-23");
    const cards = output?.report.sections[0]?.items;
    assert.equal(cards?.[0]?.source.name, "知乎热榜");
    assert.equal(cards?.[0]?.fromRadar, true);
    assert.equal(cards?.[1]?.source.name, "radar article source");
    const markdown = await dailyMarkdown("2026-11-23");
    assert.match(markdown ?? "", /来源：知乎热榜/);
    assert.match(markdown ?? "", /热文雷达：是/);
    assert.doesNotMatch(markdown ?? "", /来源：热文雷达/);
    await sql`UPDATE radar_body_tasks SET origin='' WHERE article_id='daily-radar-a'`;
    assert.match(await dailyMarkdown("2026-11-23") ?? "", /来源：example\.org/);

    await sql`UPDATE articles SET source_id='daily-radar-source' WHERE id='daily-radar-a'`;
    await sql`UPDATE publications SET source_id='daily-radar-source' WHERE article_id='daily-radar-a'`;
  } finally { installModules(previous); }
  await article('daily-radar-legacy');
  await snapshot('daily-radar-legacy-board','legacy','2026-11-25T01:00:00Z',
    [item(1,'legacy A','https://example.org/daily-radar-legacy')],[judgment(1,'legacy A')]);
  const legacyFrom=new Date('2026-11-25T00:00:00Z'), legacyTo=new Date('2026-11-26T00:00:00Z');
  assert.deepEqual((await radarDailyCandidates(legacyFrom,legacyTo)).map(x=>x.articleId),['daily-radar-legacy']);
  await sql`UPDATE articles SET body_status='pending' WHERE id='daily-radar-legacy'`;
  assert.deepEqual(await radarDailyCandidates(legacyFrom,legacyTo),[],'unfinished bodies do not become daily candidates');
  await sql`UPDATE articles SET body_status='ok' WHERE id='daily-radar-legacy'`;
  await article('daily-radar-duplicate');
  await sql`UPDATE publications SET url='https://example.org/daily-radar-legacy' WHERE article_id='daily-radar-duplicate'`;
  assert.deepEqual(await radarDailyCandidates(legacyFrom,legacyTo),[],'an ambiguous legacy URL must not guess an article');
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id='daily-radar-source'`;
  assert.deepEqual(await radarDailyCandidates(from,to), []);
});

test('history uses a readable associated detail even before it enters the pool', async () => {
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES ('history-associated','history-source','associated','https://article.example/a','待处理',now(),now())`;
  await sql`INSERT INTO publications(article_id,source_id,title,url,channel,visibility,eligible,discovered_at,timeline_at,sort_at)
    VALUES ('history-associated','history-source','待处理','https://article.example/a','news','public',false,now(),now(),now())`;
  const items = [item(1,'待处理','https://ranking.example/redirect')];
  const [snap] = await sql<{ id: number }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,results,status,fetched_at,rule_version,rule_prompt)
    VALUES ('history-linked','链接榜','测试','https://example.org',${sql.json(items)},${sql.json([judgment(1,'待处理')])},'complete','2026-11-22T00:00:00Z','v1','test') RETURNING id`;
  const [task] = await sql<{ id: number }[]>`INSERT INTO radar_body_tasks(identity_key,article_id,title,url,state)
    VALUES ('history-associated','history-associated','待处理','https://ranking.example/redirect','external') RETURNING id`;
  await sql`INSERT INTO radar_body_occurrences(snapshot_id,rank,task_id) VALUES (${snap!.id},1,${task!.id})`;
  assert.equal((await loadRadarHistory('2026-11-22',null,null,1)).items[0]!.detailUrl, '/items/history-associated');
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id='history-associated'`;
  assert.equal((await loadRadarHistory('2026-11-22',null,null,1)).items.length, 0, 'a withdrawn associated article is not revived by its ranking redirect URL');
});
