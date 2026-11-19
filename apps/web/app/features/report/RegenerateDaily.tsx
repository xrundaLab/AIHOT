// Public readers can explicitly enqueue regeneration; reading the report never starts work.
import { useEffect, useRef, useState } from "react";
import type { AdminDailyRegeneration } from "@aihot/contracts/admin";

export function RegenerateDaily({ date, generatedAt }: { date: string; generatedAt: string }) {
  const requestId = useRef<string | null>(null);
  const watching = useRef<string | null>(null);
  const [run, setRun] = useState<AdminDailyRegeneration | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const busy = submitting || run?.status === "queued" || run?.status === "running";
  useEffect(() => {
    if (submitting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/site/reports/daily/${date}/regeneration`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error("无法读取重新生成状态，请稍后刷新重试");
        const data = await res.json() as { run: AdminDailyRegeneration | null };
        setRun(data.run);
        if (data.run?.status === "queued" || data.run?.status === "running") {
          watching.current = data.run.id;
          timer = setTimeout(poll, 2000);
        } else if (data.run?.status === "done" && watching.current === data.run.id) {
          watching.current = null;
          window.location.reload();
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError((e as Error).message);
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [date, generatedAt, submitting]);

  const regenerate = async () => {
    setSubmitting(true); setError("");
    try {
      const response = await fetch(`/api/site/reports/daily/${date}/regenerate`, {
        method: "POST", credentials: "same-origin", headers: { "x-daily-regeneration": "1", "idempotency-key": requestId.current ??= crypto.randomUUID() },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail ?? "提交失败，请稍后重试");
      requestId.current = null;
      setRun(data.run);
      watching.current = data.run?.id ?? null;
    } catch (e) { setError((e as Error).message); }
    finally { setSubmitting(false); }
  };
  return (
    <div className="mt-4 text-[12px] text-ink-4">
      <button type="button" className="text-ink-4 hover:text-ink-2 disabled:cursor-wait disabled:opacity-60" disabled={busy} onClick={regenerate}>
        {busy ? "重新生成中…" : "重新生成"}
      </button>
      <p className="mt-1">更新于 {new Date(generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</p>
      {(error || run?.error) && <p role="alert" className="mt-2">{error || run?.error}</p>}
      {busy && <p role="status" className="mt-1">正在重新选稿与判断，完成后自动刷新。</p>}
    </div>
  );
}
