import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { stub, gate } from '../../../tests/setup.ts';
import { sql } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { processRadarBodies } from '../backend/body.ts';

const waiting = gate();
const resume = gate();
const provider = await stub(async (_hit, req) => {
  const url = new URL(req.url, 'http://localhost').searchParams.get('url')!;
  if (url.includes('conflict')) { waiting.open(); await resume.promise; }
  return { code: 0, title: '标题', content: url.includes('empty') ? '' : '<p>公众号正文内容</p>', author: '作者', desc: '摘要' };
});
process.env.WECHAT_PROVIDER = 'dajiala';
process.env.DAJIALA_BASE_URL = provider.url;
process.env.DAJIALA_KEY = 'test-key';
config.allowPrivateNetworkFetch = true;
after(async () => { await provider.close(); await stopBoss(); await sql.end(); });

async function add(name: string) {
  const url = `http://mp.weixin.qq.com/s/${name}`;
  const article = await upsertMaterial({ sourceId: 'radar-discovery', title: name, url, via: 'rankings' });
  await sql`INSERT INTO radar_body_tasks (identity_key,article_id,title,url,state) VALUES (${`test-${name}`},${article.articleId},${name},${url},'pending')`;
  return article.articleId;
}

test('公众号雷达先自动补采，空正文回退外部，不覆盖并发更新', async () => {
  await sql`UPDATE budgets SET per_minute=1000,per_hour=10000,per_day=100000 WHERE service='dajiala'`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,interval_minutes,enabled,health,tags) VALUES ('radar-discovery','热文雷达','external','{}'::jsonb,'EXCLUDE_MP','isolated',1440,true,'ok',${['radar']}) ON CONFLICT DO NOTHING`;
  const id = await add('success');
  const empty = await add('empty');
  await processRadarBodies();
  const [success] = await sql`SELECT a.body_text,a.body_status,a.revision,a.source_id,t.state FROM articles a JOIN radar_body_tasks t ON t.article_id=a.id WHERE a.id=${id}`;
  assert.equal(success!.body_text, '公众号正文内容');
  assert.equal(success!.body_status, 'ok');
  assert.equal(success!.revision, 2);
  assert.equal(success!.source_id, 'radar-discovery');
  assert.equal(success!.state, 'complete');
  const [failed] = await sql`SELECT t.state,a.body_status FROM radar_body_tasks t JOIN articles a ON a.id=t.article_id WHERE a.id=${empty}`;
  assert.equal(failed!.state, 'external');
  assert.notEqual(failed!.body_status, 'ok');
  const conflict = await add('conflict');
  const run = processRadarBodies();
  await waiting.promise;
  await sql`UPDATE articles SET body_text='其他正文',body_status='ok',revision=revision+1 WHERE id=${conflict}`;
  resume.open();
  await run;
  const [saved] = await sql`SELECT body_text FROM articles WHERE id=${conflict}`;
  assert.equal(saved!.body_text, '其他正文');
});
