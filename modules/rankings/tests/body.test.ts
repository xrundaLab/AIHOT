import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { sql } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { recordRadarTasks, processRadarBodies, claimExternalTask, submitExternalBody, releaseExternalTask } from '../backend/body.ts';

after(async () => { await stopBoss(); await sql.end(); });

test('radar discovers once, hands unsupported pages to external collectors, and accepts idempotent revision-safe bodies', async () => {
  await sql`INSERT INTO radar_body_activation (id,activated_at) VALUES (true,now()-interval '1 day') ON CONFLICT (id) DO UPDATE SET activated_at=excluded.activated_at`;
  const items = [
    { rank: 1, title: '微信文章', url: 'https://mp.weixin.qq.com/s/abc', heat: '', origin: '测试' },
    { rank: 2, title: '没有链接', url: null, heat: '', origin: '' },
    { rank: 3, title: '忽略', url: 'https://example.org/other', heat: '', origin: '' },
  ];
  const judgements = items.map((i, n) => ({ rank: i.rank, title: i.title, level: n === 2 ? 'B' as const : 'A' as const, reason: '', caution: '', related_ranks: [] }));
  const [s] = await sql<{ id: number; fetched_at: Date }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt) VALUES ('body-test','测试','测试','https://example.org',${sql.json(items)},now(),'v1','test') RETURNING id,fetched_at`;
  await sql.begin(tx => recordRadarTasks(tx, { ...s!, items }, judgements));
  const [s2] = await sql<{ id: number; fetched_at: Date }[]>`INSERT INTO external_ranking_snapshots(board_id,name,source,url,items,fetched_at,rule_version,rule_prompt) VALUES ('body-test','测试','测试','https://example.org',${sql.json(items)},now()+interval '1 second','v1','test') RETURNING id,fetched_at`;
  await sql.begin(tx => recordRadarTasks(tx, { ...s2!, items: [items[0]!] }, [judgements[0]!]));
  assert.equal((await sql`SELECT * FROM radar_body_tasks`).length, 2);
  assert.equal((await sql`SELECT * FROM radar_body_occurrences`).length, 3);
  await processRadarBodies();
  const task = await claimExternalTask();
  assert.ok(task);
  await assert.rejects(submitExternalBody(task.id, 'wrong', '正文'), /lease/);
  await releaseExternalTask(task.id, task.leaseToken, '暂时失败');
  const retry = await claimExternalTask();
  assert.ok(retry);
  await submitExternalBody(retry.id, retry.leaseToken, '这是一段外部获取的正文。');
  await submitExternalBody(retry.id, retry.leaseToken, '这是一段外部获取的正文。');
  await assert.rejects(submitExternalBody(retry.id, retry.leaseToken, '不同的正文'), /lease/);
  const [saved] = await sql`SELECT a.body_text,a.body_status,t.state FROM radar_body_tasks t JOIN articles a ON a.id=t.article_id WHERE t.id=${retry.id}::bigint`;
  assert.equal(saved!.body_text, '这是一段外部获取的正文。');
  assert.equal(saved!.body_status, 'ok');
  assert.equal(saved!.state, 'complete');
});

test('external body cannot overwrite an article changed after it was claimed', async () => {
  const [article] = await sql<{ id: string }[]>`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES ('body-conflict','radar-discovery','url:https://example.org/conflict','https://example.org/conflict','冲突',now(),now()) RETURNING id`;
  await sql`INSERT INTO radar_body_tasks (identity_key,article_id,title,url,state) VALUES ('url:https://example.org/conflict',${article!.id},'冲突','https://example.org/conflict','external')`;
  const task = await claimExternalTask();
  assert.ok(task);
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${article!.id}`;
  await assert.rejects(submitExternalBody(task.id, task.leaseToken, '外部正文'), /article changed/);
  const [saved] = await sql`SELECT body_text FROM articles WHERE id=${article!.id}`;
  assert.equal(saved!.body_text, null);
});

test('automatically extracts a readable page before requesting an external collector', async () => {
  const http = await import('node:http');
  const { config } = await import('@aihot/backend/config');
  const { upsertMaterial } = await import('@aihot/backend/content/materials');
  const page = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>正文</title></head><body><article><h1>正文</h1><p>${'This article contains substantive reporting and important details for readers. '.repeat(15)}</p></article></body></html>`);
  });
  await new Promise<void>(resolve => page.listen(0, '127.0.0.1', resolve));
  const old = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/article`;
    const material = await upsertMaterial({ sourceId: 'radar-discovery', title: '正文', url, via: 'rankings' });
    await sql`INSERT INTO radar_body_tasks (identity_key,article_id,title,url,state) VALUES ('url:test-auto',${material.articleId},'正文',${url},'pending')`;
    await processRadarBodies();
    const [saved] = await sql`SELECT t.state,a.body_status,a.body_text FROM radar_body_tasks t JOIN articles a ON a.id=t.article_id WHERE t.identity_key='url:test-auto'`;
    assert.equal(saved!.state, 'complete');
    assert.equal(saved!.body_status, 'ok');
    assert.match(saved!.body_text, /substantive reporting/);
  } finally {
    config.allowPrivateNetworkFetch = old;
    await new Promise<void>((resolve, reject) => page.close(error => error ? reject(error) : resolve()));
  }
});
