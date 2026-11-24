import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { sql } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { rankingsServer } from '../server.ts';

process.env.INGEST_TOKEN = 'radar-api-token-123456789';
const app = Fastify();
rankingsServer.http!(app);
after(async () => { await app.close(); await stopBoss(); await sql.end(); });

test('external task API requires authentication and validates input', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/ingest/radar/tasks' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/radar' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/radar/tasks/1/retry' })).statusCode, 401);
  const headers = { authorization: 'Bearer radar-api-token-123456789' };
  const list = await app.inject({ method: 'GET', url: '/api/ingest/radar/tasks', headers });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { tasks: [], nextCursor: null });
  assert.equal((await app.inject({ method: 'GET', url: '/api/ingest/radar/tasks?after=bad', headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/ingest/radar/tasks/claim', headers })).json().task, null);
  assert.equal((await app.inject({ method: 'POST', url: '/api/ingest/radar/tasks/1/body', headers, payload: { leaseToken: 'token', bodyText: '' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/ingest/radar/tasks/1/body', headers, payload: { leaseToken: 'token', bodyHtml: 42 } })).statusCode, 400);
});

test('external HTML is sanitized, preserved and safely retried', async () => {
  const headers = { authorization: 'Bearer radar-api-token-123456789' };
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,interval_minutes,enabled,health,tags)
    VALUES ('html-test','HTML test','external','{}'::jsonb,'EXCLUDE_MP','isolated',1440,true,'ok',ARRAY[]::text[])`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES ('html-test','html-test','url:https://example.org/article','https://example.org/article','HTML test',now(),now())`;
  await sql`INSERT INTO radar_body_tasks (identity_key,article_id,title,url,state)
    VALUES ('url:https://example.org/article','html-test','HTML test','https://example.org/article','external')`;
  const task = (await app.inject({ method: 'POST', url: '/api/ingest/radar/tasks/claim', headers })).json().task;
  const url = `/api/ingest/radar/tasks/${task.id}/body`;
  const send = (payload: object) => app.inject({ method: 'POST', url, headers, payload });
  assert.equal((await send({ leaseToken: task.leaseToken, bodyHtml: '<script>unsafe()</script>' })).statusCode, 400);
  const payload = { leaseToken: task.leaseToken, bodyHtml: '<h2>标题</h2><p>正文 <strong>重点</strong></p><script>unsafe()</script><img src="/photo.jpg" onerror="unsafe()">', bodyText: '被忽略', images: ['https://example.org/photo.jpg'] };
  assert.equal((await send(payload)).statusCode, 200);
  assert.equal((await send(payload)).statusCode, 200);
  assert.equal((await send({ ...payload, bodyHtml: '<p>不同正文</p>' })).statusCode, 409);
  const [saved] = await sql`SELECT a.body_text,a.body_html,a.body_status,t.state FROM radar_body_tasks t JOIN articles a ON a.id=t.article_id WHERE t.id=${task.id}::bigint`;
  assert.match(saved!.body_text, /正文.*重点/);
  assert.doesNotMatch(saved!.body_text, /被忽略|unsafe/);
  assert.match(saved!.body_html, /<strong>重点<\/strong>/);
  assert.doesNotMatch(saved!.body_html, /script|onerror/);
  assert.equal((saved!.body_html.match(/https:\/\/example.org\/photo.jpg/g) ?? []).length, 1);
  assert.equal(saved!.body_status, 'ok');
  assert.equal(saved!.state, 'complete');
});

test('radar admin requires CSRF and audits an accepted retry', async () => {
  const { config } = await import('@aihot/backend/config');
  config.devAdmin = { displayName: 'Radar Test' };
  try {
    await sql`INSERT INTO radar_body_tasks(identity_key,title,url,state) VALUES ('admin-test','待重试','https://example.org/test','external')`;
    const status = await app.inject({ url: '/api/admin/radar' });
    assert.equal(status.statusCode, 200);
    const task = status.json().tasks.find((t: { title: string }) => t.title === '待重试');
    assert.ok(task);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/radar/tasks/${task.id}/retry` })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/admin/radar/tasks/${task.id}/retry`, headers: { 'x-csrf-token': 'dev' } })).statusCode, 200);
    const [changed] = await sql`SELECT state FROM radar_body_tasks WHERE id=${task.id}::bigint`;
    assert.equal(changed!.state, 'pending');
    const [entry] = await sql`SELECT action FROM audit_log WHERE action='radar.retry'`;
    assert.equal(entry!.action, 'radar.retry');
  } finally { config.devAdmin = null; }
});
