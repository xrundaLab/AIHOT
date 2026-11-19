import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { sql } from '@aihot/backend/db';
import { rankingsServer } from '../server.ts';

process.env.INGEST_TOKEN = 'radar-api-token-123456789';
const app = Fastify();
rankingsServer.http!(app);
after(async () => { await app.close(); await sql.end(); });

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
