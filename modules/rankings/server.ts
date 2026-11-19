import { defineServerModule } from "@aihot/backend/modules";
import { collectRankings, collectWxRankings, collectTopRankings } from "./backend/collect.ts";
import { loadRankings } from "./backend/publication.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import { sessionPrincipal, actorOf } from "@aihot/backend/admin/auth";
import { audit } from "@aihot/backend/audit";
import { timingSafeEqual } from "node:crypto";
import { credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { claimExternalTask, processRadarBodies, processRadarPublications, submitExternalBody, releaseExternalTask, RadarTaskError } from "./backend/body.ts";
import { screenRankings } from "./backend/screen.ts";
export const rankingsServer = defineServerModule({
  name: "rankings",
  summaryOnlySources: ["radar-discovery"],
  async listUndated(articleId, db) {
    const [row] = await db`SELECT 1 FROM articles a JOIN sources s ON s.id=a.source_id
      WHERE a.id=${articleId} AND a.source_id='radar-discovery' AND s.enabled AND s.participation_mode='editorial'
        AND a.backfill_reason='unknown-publication-time'
        AND EXISTS (SELECT 1 FROM radar_body_tasks t WHERE t.article_id=a.id)`;
    return !!row;
  },
  pool: {
    filter(key) { return key === "radar" ? sql`AND EXISTS (SELECT 1 FROM radar_body_tasks rt WHERE rt.article_id=p.article_id)` : undefined; },
    async annotate(ids) {
      if (!ids.length) return {};
      const rows = await sql<{ article_id: string; origin: string; source_id: string }[]>`SELECT t.article_id,t.origin,a.source_id FROM radar_body_tasks t JOIN articles a ON a.id=t.article_id WHERE t.article_id=ANY(${ids}::text[])`;
      return Object.fromEntries(rows.map(r => [r.article_id, { badge: "热文雷达", ...(r.source_id === "radar-discovery" && r.origin ? { sourceName: `${r.origin}（榜单标注）` } : {}) }]));
    },
  },
  http(app) {
    app.get("/api/site/rankings", async (_req, reply) => { reply.header("Cache-Control", "public, max-age=60"); return { boards: await loadRankings() }; });
    const authorized = (header: string | undefined) => {
      const expected = credential("auth", "INGEST_TOKEN") ?? "";
      const given = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
      if (expected.length < 16 || /^(changeme|change-me|placeholder|xxx+|todo|test|dev|your[-_]?token.*)$/i.test(expected)) return false;
      const a = Buffer.from(given), b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    const admin = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store");
      const principal = await sessionPrincipal(req.headers.cookie);
      if (!principal) { reply.code(401).send({ detail: "请先登录" }); return null; }
      if (req.method !== "GET" && req.headers["x-csrf-token"] !== principal.csrf) { reply.code(403).send({ detail: "无效的 CSRF 令牌" }); return null; }
      return principal;
    };
    app.get("/api/admin/radar", async (req, reply) => {
      if (!await admin(req, reply)) return;
      const [source] = await sql`SELECT id,participation_mode,tier,updated_at,enabled FROM sources WHERE id='radar-discovery'`;
      const counts = await sql`SELECT state,count(*)::int AS count FROM radar_body_tasks GROUP BY state`;
      const tasks = await sql`SELECT t.id::text,t.title,t.url,t.origin,t.state,t.error,t.article_id,a.processing_state,p.visibility
        FROM radar_body_tasks t LEFT JOIN articles a ON a.id=t.article_id LEFT JOIN publications p ON p.article_id=a.id ORDER BY t.updated_at DESC,t.id DESC LIMIT 100`;
      return { source: source ?? null, counts, tasks };
    });
    app.post("/api/admin/radar/tasks/:id/retry", async (req, reply) => {
      const principal = await admin(req, reply); if (!principal) return;
      const { id } = req.params as { id: string };
      if (!/^[1-9]\d{0,17}$/.test(id)) return reply.code(400).send({ detail: "无效任务" });
      const changed = await sql.begin(async tx => {
        const [row] = await tx`UPDATE radar_body_tasks SET state='pending',attempts=0,error=null,lease_token=null,lease_until=null,updated_at=now()
          WHERE id=${id}::bigint AND state='external' RETURNING id`;
        if (row) await audit(actorOf(principal), "radar.retry", `radar-task:${id}`, null, { state: "external" }, { state: "pending" }, { db: tx });
        return !!row;
      });
      if (!changed) return reply.code(409).send({ detail: "任务当前不能重试" });
      return { ok: true };
    });
    app.get("/api/ingest/radar/tasks", async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const after = (req.query as { after?: unknown }).after ?? "0";
      if (typeof after !== "string" || !/^(0|[1-9]\d{0,17})$/.test(after)) return reply.code(400).send({ error: "invalid cursor" });
      const tasks = await sql`SELECT id::text,title,url,origin,state,error,updated_at AS "updatedAt" FROM radar_body_tasks WHERE state IN ('external','manual','leased') AND id > ${after}::bigint ORDER BY id LIMIT 100`;
      return { tasks, nextCursor: tasks.length === 100 ? tasks.at(-1)!.id : null };
    });
    app.post("/api/ingest/radar/tasks/claim", async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      return { task: await claimExternalTask() };
    });
    app.post("/api/ingest/radar/tasks/:id/failure", { bodyLimit: 4096 }, async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const { id } = req.params as { id: string };
      const body = req.body as { leaseToken?: unknown; error?: unknown } | null;
      if (typeof body?.leaseToken !== "string" || typeof body?.error !== "string") return reply.code(400).send({ error: "leaseToken and error required" });
      try { await releaseExternalTask(id, body.leaseToken, body.error); return { ok: true }; }
      catch (error) { if (error instanceof RadarTaskError) return reply.code(error.status).send({ error: error.message }); throw error; }
    });
    app.post("/api/ingest/radar/tasks/:id/body", { bodyLimit: 4_100_000 }, async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
      const { id } = req.params as { id: string };
      const body = req.body as { leaseToken?: unknown; bodyText?: unknown; images?: unknown } | null;
      if (typeof body?.leaseToken !== "string" || typeof body?.bodyText !== "string") return reply.code(400).send({ error: "leaseToken and bodyText required" });
      if (body.images !== undefined && (!Array.isArray(body.images) || body.images.some(image => typeof image !== "string"))) return reply.code(400).send({ error: "invalid images" });
      try { await submitExternalBody(id, body.leaseToken, body.bodyText, body.images as string[] | undefined); return { ok: true }; }
      catch (error) { if (error instanceof RadarTaskError) return reply.code(error.status).send({ error: error.message }); throw error; }
    });
  },
  schedules: [{ name: "rankings.publications", cron: "* * * * *", when: () => process.env.MODEL_CALLS_ENABLED === "true", run: processRadarPublications }, { name: "rankings.body", cron: "* * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: processRadarBodies }, { name: "rankings.collect", cron: "10 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectRankings }, { name: "rankings.wxrank", cron: "20 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectWxRankings }, { name: "rankings.tophub", cron: "35 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectTopRankings }, { name: "rankings.screen", cron: "* * * * *", when: () => process.env.MODEL_CALLS_ENABLED === "true", run: screenRankings }],
});
