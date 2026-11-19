import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { bodyModeOf } from "@aihot/backend/publication/rules";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { updateSource } from "@aihot/backend/admin/sources";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { rankingsServer } from "../server.ts";
import { processRadarPublications } from "../backend/body.ts";

after(async () => { installModules([]); await stopBoss(); await sql.end(); });

test("radar filter, counts, search and public eligibility agree", async () => {
  installModules([rankingsServer]);
  assert.equal(bodyModeOf({ id: 'radar-discovery', name: '热文雷达', kind: 'external', tier: 'EXCLUDE_MP', participation_mode: 'editorial', first_party: false, site_fulltext: true, syndicate_fulltext: true }, 'ok', true), 'summary');
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES ('feed-source','来源','rss','editorial')`;
  const add = async (id: string, visibility = 'public') => {
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES (${id},'feed-source',${id},${`https://example.org/${id}`},${id},now(),now())`;
    await sql`INSERT INTO publications(article_id,source_id,title,summary,url,channel,visibility,eligible,discovered_at,timeline_at,sort_at,search_text)
      VALUES (${id},'feed-source',${id},'摘要',${`https://example.org/${id}`},'news',${visibility},true,now(),now(),now(),${id})`;
  };
  await add('radar-one'); await add('radar-hidden', 'withdrawn'); await add('ordinary');
  await sql`INSERT INTO pool_search(article_id,direct,body) VALUES ('radar-one','radar-one',''),('ordinary','ordinary','')`;
  await sql`UPDATE publications SET category='news' WHERE article_id='radar-one'`;
  await sql`INSERT INTO radar_body_tasks(identity_key,article_id,title,url,state) VALUES ('one','radar-one','radar-one','https://example.org/radar-one','complete'),('hidden','radar-hidden','radar-hidden','https://example.org/radar-hidden','complete')`;
  const snapshots = await sql<{ id: number }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt)
    VALUES ('test-a','榜一','来源','https://example.org','[]',now(),'v1','test'),('test-b','榜二','来源','https://example.org','[]',now(),'v1','test') RETURNING id`;
  await sql`INSERT INTO radar_body_occurrences(snapshot_id,rank,task_id) SELECT x.id,1,t.id FROM unnest(${snapshots.map(s => s.id)}::bigint[]) AS x(id),radar_body_tasks t WHERE t.identity_key='one'`;
  const base = { channel: 'all' as const, category: null, tag: null, now: new Date() };
  const all = await loadPool(base);
  assert.equal(all.total, 2);
  assert.equal(all.items.find(x => x.id === 'radar-one')?.badge, '热文雷达');
  const filtered = await loadPool({ ...base, collection: 'radar' });
  assert.deepEqual(filtered.items.map(x => x.id), ['radar-one']);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.todayCount, 1);
  const search = await loadPool({ ...base, collection: 'radar', q: 'radar' });
  assert.equal(search.total, 1);
  assert.equal(search.items[0]?.id, 'radar-one');
  assert.equal((await loadPool({ ...base, collection: 'radar', category: 'news', q: 'radar', tab: 'relevance', sort: 'published' })).total, 1);
  assert.equal((await loadPool({ ...base, collection: 'radar', category: 'policy' })).total, 0);
  assert.equal((await loadPool({ ...base, collection: 'unknown' })).total, 0);
});

test("isolated radar items are queued for analysis only when editorial publishing is enabled", async () => {
  await sql`INSERT INTO sources(id,name,kind,participation_mode,tier) VALUES ('radar-discovery','热文雷达','external','isolated','EXCLUDE_MP')`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_status,discovered_at,timeline_at,processing_state) VALUES ('radar-queue','radar-discovery','queue','https://example.org/q','标题','unconfirmed',now(),now(),'skipped')`;
  await sql`INSERT INTO radar_body_tasks(identity_key,article_id,title,url,state) VALUES ('queue','radar-queue','标题','https://example.org/q','external')`;
  await processRadarPublications();
  let [row] = await sql`SELECT processing_state,processing_queued_at FROM articles WHERE id='radar-queue'`;
  assert.equal(row!.processing_state, 'skipped');
  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id='radar-discovery'`;
  await updateSource('radar-discovery', { patch: { participation_mode: 'editorial', tier: 'EXCLUDE_MP' }, version: source!.updated_at.toISOString(), reason: '开启雷达动态发布' }, 'test');
  await processRadarPublications();
  [row] = await sql`SELECT processing_state,processing_queued_at FROM articles WHERE id='radar-queue'`;
  assert.equal(row!.processing_state, 'new');
  assert.ok(row!.processing_queued_at);
  await sql`UPDATE articles SET backfill=true,backfill_reason='unknown-publication-time',grouping_status='complete' WHERE id='radar-queue'`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected) VALUES ('radar-queue',1,'rule','pass','雷达标题','雷达摘要',true)`;
  await publishArticle('radar-queue');
  const [published] = await sql`SELECT eligible,selected,published_at FROM publications WHERE article_id='radar-queue'`;
  assert.deepEqual([published!.eligible,published!.selected,published!.published_at], [true,false,null]);
  await sql`UPDATE articles SET backfill_reason='reported-backfill' WHERE id='radar-queue'`;
  await publishArticle('radar-queue');
  const [archive] = await sql`SELECT eligible FROM publications WHERE article_id='radar-queue'`;
  assert.equal(archive!.eligible, false);
});
