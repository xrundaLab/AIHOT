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
  const headers = { authorization: 'Bearer radar-api-token-123456789' };
  const list = await app.inject({ method: 'GET', url: '/api/ingest/radar/tasks', headers });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { tasks: [], nextCursor: null });
  assert.equal((await app.inject({ method: 'GET', url: '/api/ingest/radar/tasks?after=bad', headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/ingest/radar/tasks/claim', headers })).json().task, null);
  assert.equal((await app.inject({ method: 'POST', url: '/api/ingest/radar/tasks/1/body', headers, payload: { leaseToken: 'token', bodyText: '' } })).statusCode, 400);
});
