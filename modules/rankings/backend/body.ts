import { createHash, randomUUID } from "node:crypto";
import { sql, type Db } from "@aihot/backend/db";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { contentHash, reviseMaterial, upsertMaterial } from "@aihot/backend/content/materials";
import { withPushedImages } from "@aihot/backend/content/presentation";
import { textToHtml } from "@aihot/backend/content/sanitize";
import { extractArticleBody, pageFetchable } from "@aihot/backend/content/extract";
import { queueProcessing } from "@aihot/backend/jobs/content";
import type { Entry } from "./tunbang.ts";
import type { RankingJudgement } from "./screen.ts";

/** Called in the same transaction as screening so a crash cannot lose work. */
export async function recordRadarTasks(db: Db, snapshot: { id: number; fetched_at: Date; items: Entry[] }, results: RankingJudgement[]) {
  await db`INSERT INTO radar_body_activation (id) VALUES (true) ON CONFLICT (id) DO NOTHING`;
  const [enabled] = await db`SELECT 1 FROM radar_body_activation WHERE activated_at <= ${snapshot.fetched_at} LIMIT 1`;
  if (!enabled) return;
  await db`INSERT INTO sources (id,name,kind,config,tier,participation_mode,interval_minutes,enabled,health,tags)
    VALUES ('radar-discovery','热文雷达','external','{}'::jsonb,'T2','isolated',1440,true,'ok',${["radar"]}) ON CONFLICT (id) DO NOTHING`;
  const judgments = new Map(results.map(j => [j.rank, j]));
  for (const item of snapshot.items) {
    const j = judgments.get(item.rank);
    if (j?.level !== 'A' || j.title !== item.title) continue;
    const [existing] = await db`SELECT 1 FROM radar_body_occurrences WHERE snapshot_id=${snapshot.id} AND rank=${item.rank}`;
    if (existing) continue;
    const identity = item.url ? identityKeyForUrl(item.url) : null;
    let task: { id: number } | undefined;
    if (identity && item.url) {
      const [known] = await db<{ id: string }[]>`SELECT id FROM articles WHERE identity_key=${identity}`;
      const articleId = known?.id ?? (await upsertMaterial({ sourceId: 'radar-discovery', url: item.url, title: item.title, via: 'rankings' }, db)).articleId;
      [task] = await db<{ id: number }[]>`INSERT INTO radar_body_tasks (identity_key,article_id,title,url,origin)
        VALUES (${identity},${articleId},${item.title},${item.url},${item.origin})
        ON CONFLICT (identity_key) DO UPDATE SET identity_key=excluded.identity_key RETURNING id`;
    } else {
      [task] = await db<{ id: number }[]>`INSERT INTO radar_body_tasks (title,url,origin,state,error)
        VALUES (${item.title},${item.url},${item.origin},'manual','没有有效的文章链接') RETURNING id`;
    }
    await db`INSERT INTO radar_body_occurrences (snapshot_id,rank,task_id) VALUES (${snapshot.id},${item.rank},${task!.id}) ON CONFLICT DO NOTHING`;
  }
}

/** Bounded attempts; abandoned claims can be reclaimed after a restart. */
export async function processRadarBodies() {
  await sql`UPDATE radar_body_tasks t SET state='complete',error=null,updated_at=now()
    FROM articles a WHERE t.article_id=a.id AND t.state IN ('pending','external') AND a.body_status='ok'`;
  for (let n = 0; n < 5; n++) {
    const claim = randomUUID();
    const [task] = await sql<{ id: number; article_id: string; attempts: number; url: string; kind: string; body_status: string }[]>`
      WITH candidate AS (SELECT id FROM radar_body_tasks WHERE state='pending' OR (state='running' AND lease_until < now())
        ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1),
      claimed AS (UPDATE radar_body_tasks t SET state='running',lease_token=${claim},lease_until=now()+interval '10 minutes',attempts=t.attempts+1,updated_at=now()
        FROM candidate c WHERE t.id=c.id RETURNING t.*)
      SELECT c.id,c.article_id,c.attempts,a.url,s.kind,a.body_status FROM claimed c JOIN articles a ON a.id=c.article_id JOIN sources s ON s.id=a.source_id`;
    if (!task) break;
    try {
      if (task.body_status === 'ok') {
        await sql`UPDATE radar_body_tasks SET state='complete',error=null,lease_until=null,updated_at=now() WHERE id=${task.id} AND state='running' AND lease_token=${claim}`;
      } else if (!pageFetchable(task.url, task.kind)) {
        await sql`UPDATE radar_body_tasks SET state='external',error='该来源不支持自动网页抓取',lease_until=null,updated_at=now() WHERE id=${task.id} AND state='running' AND lease_token=${claim}`;
      } else {
        const result = await extractArticleBody(task.article_id);
        const [current] = await sql<{ body_status: string }[]>`SELECT body_status FROM articles WHERE id=${task.article_id}`;
        const complete = result === 'ok' || current?.body_status === 'ok';
        if (complete) await queueProcessing(task.article_id);
        await sql`UPDATE radar_body_tasks SET state=${complete ? 'complete' : 'external'},error=${complete ? null : '未能确认正文'},lease_until=null,updated_at=now() WHERE id=${task.id} AND state='running' AND lease_token=${claim}`;
      }
    } catch (error) {
      await sql`UPDATE radar_body_tasks SET state=${task.attempts < 3 ? 'pending' : 'external'},error=${String(error).slice(0, 500)},lease_until=null,updated_at=now() WHERE id=${task.id} AND state='running' AND lease_token=${claim}`;
    }
  }
}

export async function claimExternalTask() {
  const token = randomUUID();
  const [task] = await sql`WITH candidate AS (
    SELECT id FROM radar_body_tasks WHERE state='external' OR (state='leased' AND lease_until < now())
    ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE radar_body_tasks t SET state='leased',lease_token=${token},lease_until=now()+interval '30 minutes',
      leased_revision=a.revision,updated_at=now() FROM candidate c,articles a
    WHERE t.id=c.id AND a.id=t.article_id RETURNING t.id::text,t.title,t.url,t.origin,t.error,t.lease_token AS "leaseToken",t.lease_until AS "leaseUntil"`;
  return task ?? null;
}

export class RadarTaskError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export async function submitExternalBody(id: string, token: string, bodyText: string, images: string[] = []) {
  if (!/^[1-9]\d{0,17}$/.test(id) || !token || !bodyText.trim() || bodyText.length > 1_000_000) throw new RadarTaskError(400, 'invalid task or body');
  const text = bodyText.trim();
  if (images.length > 6 || images.some(value => { try { const url = new URL(value); return value.length > 2048 || !['http:', 'https:'].includes(url.protocol); } catch { return true; } })) throw new RadarTaskError(400, 'invalid images');
  const imageUrls = [...new Set(images)];
  const resultHash = createHash('sha256').update(JSON.stringify({ text, images: imageUrls })).digest('hex');
  await sql.begin(async tx => {
    const [task] = await tx<{ article_id: string; leased_revision: number; state: string; lease_token: string; lease_until: Date; result_hash: string | null }[]>`SELECT article_id,leased_revision,state,lease_token,lease_until,result_hash FROM radar_body_tasks WHERE id=${id}::bigint FOR UPDATE`;
    if (task?.state === 'complete' && task.lease_token === token) {
      if (task.result_hash === resultHash) return;
    }
    if (!task || task.state !== 'leased' || task.lease_token !== token || !task.lease_until || task.lease_until.getTime() <= Date.now()) throw new RadarTaskError(409, 'task lease is invalid or expired');
    const [article] = await tx<{ revision: number; body_status: string; title: string; excerpt: string | null; media: Array<{ kind: string; url: string }> }[]>`SELECT revision,body_status,title,excerpt,media FROM articles WHERE id=${task.article_id} FOR UPDATE`;
    if (!article || article.revision !== task.leased_revision || article.body_status === 'ok') throw new RadarTaskError(409, 'article changed since claim');
    const html = withPushedImages(textToHtml(text), imageUrls);
    const media = [...article.media, ...imageUrls.filter(url => !article.media.some(m => m.kind === 'image' && m.url === url)).map(url => ({ kind: 'image', url }))];
    await reviseMaterial(tx, task.article_id, { set: sql`body_text=${text},body_html=${html},body_status='ok',media=${tx.json(media as never)}`, hash: contentHash({ title: article.title, bodyText: text, excerpt: article.excerpt }), title: article.title, bodyText: text });
    await queueProcessing(task.article_id, { db: tx });
    await tx`UPDATE radar_body_tasks SET state='complete',lease_until=null,error=null,result_hash=${resultHash},updated_at=now() WHERE id=${id}::bigint`;
  });
}

export async function releaseExternalTask(id: string, token: string, error: string) {
  if (!/^[1-9]\d{0,17}$/.test(id) || !token || !error.trim()) throw new RadarTaskError(400, 'invalid task or error');
  const rows = await sql`UPDATE radar_body_tasks SET state='external',error=${error.trim().slice(0, 500)},lease_until=null,lease_token=null,updated_at=now()
    WHERE id=${id}::bigint AND state='leased' AND lease_token=${token} AND lease_until>now() RETURNING id`;
  if (!rows.length) throw new RadarTaskError(409, 'task lease is invalid or expired');
}
