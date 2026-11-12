import type { FastifyInstance } from "fastify";
import { FeedbackRejected, submitFeedback, recordArticleReview, addArticleReviewNote, type FeedbackInput } from "@aihot/backend/operations/feedback";
import { clientIp, sendProblem } from "../http/respond.ts";

type FeedbackBody = Pick<FeedbackInput, "content" | "email" | "pageUrl" | "screenshot">;

/** The feedback form as the site posts it: multipart, with at most one screenshot file. */
async function readForm(raw: unknown, contentType: string): Promise<FeedbackBody> {
  let form: FormData;
  try {
    form = await new Response(raw as Buffer<ArrayBuffer>, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确，请重新提交。");
  }
  const text = (key: string) => {
    const value = form.get(key);
    if (value !== null && typeof value !== "string") throw new FeedbackRejected(400, "invalid_request", "反馈文字格式不正确。");
    return value;
  };
  const file = form.get("screenshot");
  if (file !== null && !(file instanceof File)) throw new FeedbackRejected(400, "invalid_request", "截图上传格式不正确。");
  return {
    content: text("content") ?? "", email: text("email"), pageUrl: text("pageUrl"),
    screenshot: file ? { mime: file.type, data: Buffer.from(await file.arrayBuffer()) } : null,
  };
}

export function registerFeedback(app: FastifyInstance) {
  app.post("/api/site/items/:id/reviews", { bodyLimit: 4096 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const vote = (req.body as { vote?: unknown } | null)?.vote;
    reply.header("Cache-Control", "no-store");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || (vote !== "up" && vote !== "down")) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "invalid review" });
    try {
      const result = await recordArticleReview(id, vote, clientIp(req), String(req.headers["user-agent"] ?? ""));
      if (result.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found" });
      if (result.kind === "limited") return sendProblem(req, reply, { status: 429, code: "rate_limited", detail: "评价过于频繁，请稍后再试。", retryAfter: 3600 });
      return reply.code(201).send({ id: result.id });
    } catch (error) {
      req.log.error({ err: error }, "article review failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法提交，请稍后再试。", retryAfter: 30 });
    }
  });

  app.patch("/api/site/items/:id/reviews/:reviewId", { bodyLimit: 4096 }, async (req, reply) => {
    const { id, reviewId } = req.params as { id: string; reviewId: string };
    const note = (req.body as { note?: unknown } | null)?.note;
    reply.header("Cache-Control", "no-store");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewId) || typeof note !== "string" || note.length > 1000 || note.includes("\0")) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: "invalid note" });
    try {
      if (!await addArticleReviewNote(id, reviewId, note)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "review not found" });
      return reply.send({ ok: true });
    } catch (error) {
      req.log.error({ err: error }, "article review note failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法提交，请稍后再试。", retryAfter: 30 });
    }
  });

  // Bounded by the same request limit as JSON; native multipart parsing avoids base64 on the wire.
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post("/api/site/feedback", { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    try {
      const body = await readForm(req.body, String(req.headers["content-type"] ?? ""));
      const result = await submitFeedback({ ...body, ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "") });
      return reply.header("Cache-Control", "no-store").code(201).send(result);
    } catch (error) {
      if (error instanceof FeedbackRejected) return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message, retryAfter: error.retryAfter });
      req.log.error({ err: error }, "feedback failed");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法提交，请稍后再试。", retryAfter: 30 });
    }
  });
}
