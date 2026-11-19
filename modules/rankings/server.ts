import { defineServerModule } from "@aihot/backend/modules";
import { collectRankings, collectWxRankings, collectTopRankings } from "./backend/collect.ts";
import { loadRankings } from "./backend/publication.ts";
import { timingSafeEqual } from "node:crypto";
import { credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { claimExternalTask, processRadarBodies, submitExternalBody, releaseExternalTask, RadarTaskError } from "./backend/body.ts";
import { screenRankings } from "./backend/screen.ts";
export const rankingsServer = defineServerModule({
  name: "rankings",
  http(app) {
    app.get("/api/site/rankings", async (_req, reply) => { reply.header("Cache-Control", "public, max-age=60"); return { boards: await loadRankings() }; });
    const authorized = (header: string | undefined) => {
      const expected = credential("auth", "INGEST_TOKEN") ?? "";
      const given = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1]?.trim() ?? "";
      if (expected.length < 16 || /^(changeme|change-me|placeholder|xxx+|todo|test|dev|your[-_]?token.*)$/i.test(expected)) return false;
      const a = Buffer.from(given), b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    };
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
  schedules: [{ name: "rankings.body", cron: "* * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: processRadarBodies }, { name: "rankings.collect", cron: "10 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectRankings }, { name: "rankings.wxrank", cron: "20 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectWxRankings }, { name: "rankings.tophub", cron: "35 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectTopRankings }, { name: "rankings.screen", cron: "* * * * *", when: () => process.env.MODEL_CALLS_ENABLED === "true", run: screenRankings }],
});
