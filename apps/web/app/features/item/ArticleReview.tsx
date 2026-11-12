import { useState } from "react";
import { Sheet } from "../../components/ui/Sheet";

export function ArticleReview({ itemId }: { itemId: string }) {
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const url = `/api/site/items/${encodeURIComponent(itemId)}/reviews`;

  async function vote(value: "up" | "down") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vote: value }) });
      if (!response.ok) throw new Error();
      const data = await response.json() as { id: string };
      setReviewId(data.id);
      setNote("");
      setMessage("评价已记录");
      setOpen(true);
    } catch {
      setMessage("评价未能保存，请稍后重试。");
    } finally { setBusy(false); }
  }

  async function saveNote() {
    if (!reviewId) return;
    setBusy(true);
    try {
      const response = await fetch(`${url}/${encodeURIComponent(reviewId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) });
      if (!response.ok) throw new Error();
      setOpen(false);
      setMessage("评价和备注已记录");
    } catch { setMessage("备注未能保存，请重试。"); }
    finally { setBusy(false); }
  }

  return <div>
    <div className="flex gap-2">
      <button type="button" disabled={busy} onClick={() => void vote("up")} className="rounded-control border border-line-strong px-4 py-2 text-sm hover:text-accent disabled:opacity-50" aria-label="评价为赞">👍 赞</button>
      <button type="button" disabled={busy} onClick={() => void vote("down")} className="rounded-control border border-line-strong px-4 py-2 text-sm hover:text-accent disabled:opacity-50" aria-label="评价为踩">👎 踩</button>
    </div>
    {message && !open && <p role="status" className="mt-2 text-xs text-ink-3">{message}</p>}
    <Sheet open={open} onClose={() => setOpen(false)} title="添加评价备注" centered>
      <div className="space-y-4 px-4 pb-5">
        <p className="text-sm text-ink-3">评价已记录，可填写理由，也可以直接关闭。</p>
        <label className="block text-sm text-ink-2">备注（选填）<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={4} className="mt-2 w-full rounded-control border border-line-strong bg-bg p-3 text-ink" /></label>
        {message && <p role="status" className="text-xs text-ink-3">{message}</p>}
        <button type="button" disabled={busy} onClick={() => void saveNote()} className="rounded-control bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">提交备注</button>
      </div>
    </Sheet>
  </div>;
}
