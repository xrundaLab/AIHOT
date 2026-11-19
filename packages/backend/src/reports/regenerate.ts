// Explicit reader commands enqueue work; only a worker composes a daily and pays for its review.
import type { AdminDailyRegeneration } from "@aihot/contracts/admin";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { enqueue, ensureQueue, QUEUES } from "../jobs/queue.ts";
import { dueDaily } from "./compose.ts";

export function validateDailyDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date > dueDaily()) {
    throw Object.assign(new Error("日报日期无效或尚未到出刊时间"), { statusCode: 400 });
  }
}

export async function dailyRegeneration(date: string): Promise<AdminDailyRegeneration | null> {
  validateDailyDate(date);
  await ensureQueue(QUEUES.regenerateDaily);
  const [job] = await sql<{ id: string; state: string; completed_on: Date | null; output: { message?: string } | null }[]>`
    SELECT id,state,completed_on,output FROM pgboss.job
    WHERE name = ${QUEUES.regenerateDaily} AND data->>'date' = ${date} ORDER BY created_on DESC LIMIT 1`;
  if (!job) return null;
  const status = job.state === "completed" ? "done" : ["failed", "cancelled"].includes(job.state) ? "failed" : job.state === "active" ? "running" : "queued";
  return { id: job.id, status, finishedAt: job.completed_on?.toISOString() ?? null,
    error: status === "failed" ? "重新生成失败，原日报已保留；请在后台运行记录查看详情后重试。" : null };
}

export async function requestDailyRegeneration(date: string, actor: string, requestId: string) {
  validateDailyDate(date);
  await ensureQueue(QUEUES.regenerateDaily);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`regenerate:daily:${date}`}))`;
    const existing = await tx`SELECT id FROM reports WHERE kind='daily' AND key=${date}`;
    if (!existing.length) throw Object.assign(new Error("只能重新生成已有日报"), { statusCode: 400 });
    const [command] = await tx`SELECT 1 FROM audit_log WHERE action='report.regenerate.request' AND request_id=${requestId}
      AND subject=${`report:daily:${date}`} LIMIT 1`;
    if (command) return;
    const [pending] = await tx`SELECT id FROM pgboss.job WHERE name=${QUEUES.regenerateDaily}
      AND data->>'date'=${date} AND state IN ('created','retry','active') ORDER BY created_on DESC LIMIT 1`;
    if (!pending) {
      const reason = actor === "public-reader" ? "读者手动重新生成" : "管理员手动重新生成";
      const id = await enqueue(QUEUES.regenerateDaily, { date, actor, reason, requestId }, { singletonKey: date }, tx);
      await audit(actor, "report.regenerate.request", `report:daily:${date}`, reason, null, { jobId: id }, { db: tx, requestId });
    }
  }).then(() => dailyRegeneration(date));
}
