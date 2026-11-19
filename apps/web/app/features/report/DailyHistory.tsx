import { useState } from "react";

type Revision = { revision: number; generatedAt: string };
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

export function DailyHistory({ date, historical, generatedAt }: { date: string; historical: boolean; generatedAt: string }) {
  const [items, setItems] = useState<Revision[]>([]);
  const [status, setStatus] = useState("");
  if (historical) return <p>历史版本 · {time(generatedAt)} · <a href={`/daily/${date}`}>返回当前版本</a></p>;
  return (
    <details onToggle={async e => {
      if (!e.currentTarget.open) return;
      setStatus("正在读取…");
      try {
        const response = await fetch(`/api/site/reports/daily/${date}/history`, { cache: "no-store" });
        if (!response.ok) throw new Error();
        const data = await response.json() as { items: Revision[] };
        setItems(data.items);
        setStatus(data.items.length ? "" : "暂无历史版本");
      } catch {
        setItems([]);
        setStatus("无法读取历史版本，请稍后重试。");
      }
    }}>
      <summary className="cursor-pointer">历史版本</summary>
      {status && <p role="status">{status}</p>}
      <ul>{items.map(item => (
        <li key={item.revision}><a href={`/daily/${date}/history/${item.revision}`}>第 {item.revision} 版 · {time(item.generatedAt)}</a></li>
      ))}</ul>
    </details>
  );
}
