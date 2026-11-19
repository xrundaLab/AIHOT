import { beijingDate } from "@aihot/contracts/time";
import { useMemo, useState } from "react";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { navUp } from "@aihot/web/components/shell/nav";
import { cachedPage, loadOr404, pageHeaders } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import type { Ranking } from "../backend/publication.ts";
import type { RankingJudgement } from "../backend/screen.ts";
import type { Entry } from "../backend/tunbang.ts";
import type { RadarHistory } from "../backend/history.ts";

export const handle: Screen = { tab: navUp("/hot").tab, name: "榜单大全" };
export const headers = pageHeaders;
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const now = Date.now();
  const history = url.searchParams.get("view") === "history" && (url.searchParams.get("board") === "family:radar" || !url.searchParams.get("board"));
  const rawDate = url.searchParams.get("date") ?? "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && Number.isFinite(Date.parse(`${rawDate}T00:00:00+08:00`)) && beijingDate(Date.parse(`${rawDate}T00:00:00+08:00`)) === rawDate ? rawDate : beijingDate(now);
  const query = new URLSearchParams({ date });
  for (const key of ["source", "historyBoard", "page"]) {
    const value = url.searchParams.get(key);
    if (value && (key !== "page" || /^[1-9]\d{0,5}$/.test(value))) query.set(key === "historyBoard" ? "board" : key, value.slice(0, key === "source" ? 120 : 200));
  }
  const [data, historyData] = await Promise.all([
    loadOr404<{ boards: Ranking[] }>("/api/site/rankings", { signal: request.signal }),
    history ? loadOr404<RadarHistory>(`/api/site/rankings/history?${query}`, { signal: request.signal }) : Promise.resolve(null),
  ]);
  return cachedPage(60, { ...data, now, historyData });
}
export function meta() { return pageMeta({ title: "榜单大全", description: "浏览各平台热榜与公众号榜单。", path: "/rankings" }); }

function formatTime(value: string | null) {
  if (!value) return "暂无";
  const d = new Date(value); return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

function RankingRow({ item, judgement, radar = false }: { item: Entry; judgement?: RankingJudgement; radar?: boolean }) {
  const url = radar && item.detailUrl ? item.detailUrl : item.url;
  const level = judgement?.level;
  const color = level === "A" ? "text-red-700 dark:text-red-400" : level === "B" ? "text-orange-700 dark:text-orange-400" : "text-ink";
  return <li className="flex items-start gap-4 py-4"><span className={`w-7 shrink-0 text-center text-base font-bold ${level === "A" || level === "B" ? color : item.rank <= 3 ? "text-accent" : "text-ink-4"}`}>{item.rank}</span><div className="min-w-0 flex-1">
    {level === "A" && <span className={`mr-2 text-xs font-semibold ${color}`}>A｜优先关注</span>}{level === "B" && <span className={`mr-2 text-xs font-semibold ${color}`}>B｜待看原文</span>}
    {url?.startsWith("/items/") ? <Link to={url} className={`break-words text-[15px] font-medium leading-6 ${color} hover:underline`}>{item.title}</Link> : url ? <a href={url} target="_blank" rel="noopener noreferrer" className={`break-words text-[15px] font-medium leading-6 ${color} hover:underline`}>{item.title} {radar ? "（原文）" : "↗"}</a> : <span className={`break-words text-[15px] font-medium leading-6 ${color}`}>{item.title}</span>}
    {radar && item.bodyState && <p className="mt-1 text-xs text-ink-4">{({ pending: "正文待抓取", running: "正文抓取中", external: "等待外部获取正文", leased: "外部工具获取正文中", complete: "已获取正文", manual: "缺少有效链接，待处理" } as const)[item.bodyState]}</p>}
    {(item.origin || item.metrics) && <p className="mt-1 text-xs leading-5 text-ink-4">{[item.origin, item.metrics].filter(Boolean).join(" · ")}</p>}
    {judgement && (level === "A" || level === "B") && <details className="mt-1 text-xs leading-5 text-ink-3"><summary className="cursor-pointer">判断理由与提示</summary><p>{judgement.reason}</p>{judgement.caution && <p>{judgement.caution}</p>}{judgement.related_ranks.length > 0 && <p>可能相关序号：{judgement.related_ranks.join("、")}</p>}</details>}
  </div>{item.heat && <span className="shrink-0 text-xs text-ink-4">{item.heat}</span>}</li>;
}

function RadarHistoryView({ history, change, href }: { history: RadarHistory; change: (patch: Record<string, string | null>) => void; href: (patch: Record<string, string | null>) => string }) {
  return <section aria-label="热文雷达历史记录">
    <div className="mt-5 flex flex-wrap items-end gap-3">
      <label className="text-xs text-ink-3">采集日期（北京时间）<input type="date" aria-label="采集日期" value={history.date} onChange={e => { if (e.target.value) change({ date: e.target.value, page: null, source: null, historyBoard: null }); }} className="mt-1 block max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink" /></label>
      <label className="text-xs text-ink-3">来源<select aria-label="历史来源" value={history.source ?? ""} onChange={e => change({ source: e.target.value || null, historyBoard: null, page: null })} className="mt-1 block max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"><option value="">全部来源</option>{history.sources.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
      <label className="text-xs text-ink-3">榜单<select aria-label="历史榜单" value={history.board ?? ""} onChange={e => change({ historyBoard: e.target.value || null, page: null })} className="mt-1 block max-w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"><option value="">全部榜单</option>{history.boards.map(b => <option key={b.id} value={b.id}>{b.source} · {b.name}</option>)}</select></label>
    </div>
    <p className="mt-4 text-xs leading-5 text-ink-4">展示当天已完成判断的 A 级线索；同一链接合并，时间和判断来自各榜单独立采集的快照。共 {history.total} 条。</p>
    {history.items.length ? <ol className="mt-2 divide-y divide-line-soft">{history.items.map((item, index) => <li key={`${history.page}-${index}`} className="py-4">
      {item.detailUrl ? <Link to={item.detailUrl} className="break-words text-[15px] font-medium text-ink hover:underline">{item.title}</Link> : item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="break-words text-[15px] font-medium text-ink hover:underline">{item.title}（原文）</a> : <span className="break-words text-[15px] font-medium text-ink">{item.title}</span>}
      <p className="mt-1 text-xs text-ink-4">{item.origin && <>{item.origin} · </>}当天首次 {formatTime(item.firstAt)} · 最近 {formatTime(item.lastAt)} · {item.occurrences.length} 次上榜</p>
      <details className="mt-2 text-xs leading-5 text-ink-3"><summary className="cursor-pointer">查看上榜与判断记录</summary><ol className="mt-2 space-y-2">{item.occurrences.map((o, i) => <li key={i}><p>{formatTime(o.fetchedAt)} · {o.source} · {o.board} · 第 {o.rank} 名</p><p>{o.judgement.reason}</p>{o.judgement.caution && <p>{o.judgement.caution}</p>}{o.judgement.related_ranks.length > 0 && <p>可能相关序号：{o.judgement.related_ranks.join("、")}</p>}</li>)}</ol></details>
    </li>)}</ol> : <p className="py-12 text-center text-sm text-ink-4">这一天没有符合条件的历史线索。</p>}
    {history.pageCount > 1 && <nav aria-label="历史记录分页" className="mt-5 flex items-center gap-4 text-sm">{history.page > 1 && <Link className="text-accent" to={href({ page: String(history.page - 1) })}>上一页</Link>}<span>第 {history.page} / {history.pageCount} 页</span>{history.page < history.pageCount && <Link className="text-accent" to={href({ page: String(history.page + 1) })}>下一页</Link>}</nav>}
  </section>;
}

export default function RankingsPage() {
  const { boards, now, historyData } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(""); const [choosing, setChoosing] = useState(false);
  const radarId = "family:radar";
  const radar = params.get("board") === radarId || (!params.get("board") && boards.some(b => b.source === "家友榜"));
  const selected = radar ? undefined : boards.find(b => b.id === params.get("board")) ?? boards[0];
  const radarBoards = boards.filter(b => b.source !== "家友榜" && b.screenStatus === "complete").map(board => {
    const judgements = new Map((board.judgements ?? []).map(j => [j.rank, j]));
    const items = board.items.filter(item => judgements.get(item.rank)?.title === item.title && judgements.get(item.rank)?.level === "A").sort((a, b) => a.rank - b.rank);
    return { board, items, judgements };
  }).filter(group => group.items.length > 0);
  const judgements = selected?.screenStatus === "complete" ? selected.judgements ?? [] : [];
  const byRank = new Map(judgements.map(j => [j.rank, j]));
  const priority = (selected?.items ?? []).filter(item => byRank.get(item.rank)?.title === item.title && byRank.get(item.rank)?.level === "A").sort((a, b) => a.rank - b.rank);
  const sources = useMemo(() => [...new Set(boards.map(b => b.source))], [boards]);
  const choose = (id: string) => { setParams({ board: id }); setChoosing(false); };
  const historyHref = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params); sp.set("board", radarId); sp.set("view", "history");
    for (const [key, value] of Object.entries(patch)) value === null ? sp.delete(key) : sp.set(key, value);
    const query = sp.toString(); return `/rankings?${query}`;
  };
  const changeHistory = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params); sp.set("board", radarId); sp.set("view", "history");
    for (const [key, value] of Object.entries(patch)) value === null ? sp.delete(key) : sp.set(key, value);
    setParams(sp);
  };
  return <div className="pb-12">
    <PhoneBar title="榜单大全" large back={{ to: "/hot", label: "热点" }} sub="浏览不同平台的热榜与公众号榜单" />
    <header className="hidden pb-6 pt-1 lg:block"><h1 className="text-[26px] font-bold text-ink">榜单大全</h1><p className="mt-2 text-[13.5px] text-ink-3">浏览不同平台的热榜与公众号榜单</p></header>
    <div className="mb-4 lg:hidden"><button type="button" aria-expanded={choosing} onClick={() => setChoosing(!choosing)} className="w-full rounded-card border border-line bg-surface px-4 py-3 text-left text-sm font-semibold text-ink">选择榜单 · {radar ? "热文雷达" : selected?.name ?? "暂无榜单"} <span className="float-right text-ink-4">{choosing ? "收起 ↑" : "展开 ↓"}</span></button></div>
    <div className="lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-5">
      <aside className={`${choosing ? "block" : "hidden"} mb-4 rounded-card border border-line bg-surface p-3 lg:sticky lg:top-5 lg:mb-0 lg:block lg:max-h-[calc(100vh-40px)] lg:self-start lg:overflow-y-auto`} aria-label="榜单列表">
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索榜单或来源" aria-label="搜索榜单或来源" className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-sm text-ink outline-none focus:border-accent" />
        {sources.map(source => { const query = search.toLowerCase().trim(); const list = boards.filter(b => b.source === source && `${b.name} ${b.source}`.toLowerCase().includes(query)); const showRadar = source === "家友榜" && `热文雷达 家友榜`.includes(query); if (!list.length && !showRadar) return null; return <details key={source} open className="mt-4"><summary className="cursor-pointer px-2 py-1 text-xs font-semibold text-ink-4">{source} · {list.length + (showRadar ? 1 : 0)}</summary><div className="mt-1 space-y-0.5">{showRadar && <button type="button" onClick={() => choose(radarId)} aria-current={radar ? "true" : undefined} className={`w-full rounded-lg px-3 py-2.5 text-left text-sm ${radar ? "bg-accent/10 font-semibold text-accent" : "text-ink-3 hover:bg-bg-sunk"}`}>热文雷达</button>}{list.map(b => <button type="button" key={b.id} onClick={() => choose(b.id)} aria-current={selected?.id === b.id ? "true" : undefined} className={`w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${selected?.id === b.id ? "bg-accent/10 font-semibold text-accent" : "text-ink-3 hover:bg-bg-sunk"}`}>{b.name}</button>)}</div></details>; })}
        {!boards.some(b => `${b.name} ${b.source}`.toLowerCase().includes(search.toLowerCase().trim())) && !(boards.some(b => b.source === "家友榜") && `热文雷达 家友榜`.includes(search.toLowerCase().trim())) && <p className="px-2 py-5 text-sm text-ink-4">没有找到匹配的榜单</p>}
      </aside>
      <main className="min-w-0 rounded-card border border-line bg-surface px-4 py-5 sm:px-6">
        {radar && <><div className="border-b border-line-soft pb-5"><h2 className="text-xl font-bold text-ink">热文雷达</h2><p className="mt-2 text-xs leading-5 text-ink-4">汇集各榜单优先关注的线索；榜单热度和线索判断不代表事实已核实。</p><nav aria-label="雷达记录" className="mt-4 flex gap-4 text-sm"><Link to="/rankings?board=family%3Aradar" aria-current={!historyData ? "page" : undefined} className={!historyData ? "font-semibold text-accent" : "text-ink-3"}>最新</Link><Link to={historyHref({ date: beijingDate(now), page: null, source: null, historyBoard: null })} aria-current={historyData ? "page" : undefined} className={historyData ? "font-semibold text-accent" : "text-ink-3"}>历史记录</Link></nav></div>{historyData ? <RadarHistoryView history={historyData} change={changeHistory} href={historyHref} /> : radarBoards.length ? <div className="mt-5 space-y-5">{radarBoards.map(({ board, items, judgements }) => <section key={board.id} className="rounded-card border border-line p-4" aria-label={`${board.source} · ${board.name}`}><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold text-ink">{board.source} · {board.name}</h3><Link to={`/rankings?board=${encodeURIComponent(board.id)}`} className="text-sm font-medium text-accent">查看完整榜单 →</Link></div><ol className="divide-y divide-line-soft">{items.map((item, i) => <RankingRow key={`${item.rank}-${i}`} item={item} judgement={judgements.get(item.rank)} radar />)}</ol></section>)}</div> : <p className="py-12 text-center text-sm text-ink-4">暂无优先关注的榜单线索。</p>}</>}
        {selected && <><div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft pb-5"><div><h2 className="text-xl font-bold text-ink">{selected.name}</h2><p className="mt-2 text-xs leading-5 text-ink-4">{selected.source === "家友榜" ? <>按发布时间筛选、评分排序 · 统计于 {formatTime(selected.fetchedAt)}</> : <>来源：{selected.source} · {selected.source === "今日热榜" ? "榜单日期" : "榜单更新"}：{selected.sourceUpdated ?? "暂无"} · 获取：{formatTime(selected.fetchedAt)}</>}</p></div>{selected.source === "家友榜" ? <Link to="/all" className="text-sm font-medium text-accent">查看全部动态 →</Link> : <a href={selected.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-accent">查看来源 ↗</a>}</div>
          {selected.source === "微小榜" && <p className="mt-4 text-xs leading-5 text-ink-4">{selected.id === "wxrank:account" ? "近 30 天" : "近 7 天"} · 显示来源匿名开放的前 50 条；其他周期和更多结果请前往来源查看。</p>}
          {selected.source !== "家友榜" && selected.fetchedAt && !selected.failed && now - new Date(selected.fetchedAt).getTime() > 2 * 60 * 60 * 1000 && <p className="mt-4 rounded-lg bg-bg-sunk px-3 py-2 text-sm text-ink-3">榜单已有较长时间未更新，正在显示上次获取的结果。</p>}
          {selected.failed && <p className="mt-4 rounded-lg bg-bg-sunk px-3 py-2 text-sm text-ink-3">更新失败{selected.fetchedAt ? "，正在显示上次获取的结果。" : "，暂时没有可显示的数据。"}</p>}
          {selected.source !== "家友榜" && selected.items.length > 0 && <section className="mt-5" aria-label="榜单线索判断">
            <h3 className="text-base font-semibold text-ink">优先关注</h3>
            <p className="mt-1 text-xs text-ink-4">按原榜单序号排列；榜单热度和线索判断不代表事实已核实。</p>
            {selected.screenStatus === "complete" ? priority.length ? <ol className="divide-y divide-line-soft">{priority.map((item, i) => <RankingRow key={`${item.rank}-${i}`} item={item} judgement={byRank.get(item.rank)} />)}</ol> : <p className="py-4 text-sm text-ink-3">本次未识别到直接相关内容。</p> : <p className="py-4 text-sm text-ink-3">{selected.screenStatus === "failed" ? "判断失败，原始榜单仍可查看。" : "判断中，原始榜单仍可查看。"}</p>}
          </section>}
          {selected.unavailable && <p className="mt-5 text-sm leading-7 text-ink-3">{selected.unavailable} <a href={selected.url} target="_blank" rel="noopener noreferrer" className="text-accent">前往来源查看 ↗</a></p>}
          {!selected.unavailable && !selected.items.length && !selected.failed && <p className="py-12 text-center text-sm text-ink-4">{selected.source === "家友榜" ? "这个时间范围内暂无有评分的公开动态。" : "暂无榜单数据，等待后台采集。"}</p>}
          {!!selected.items.length && <ol className="divide-y divide-line-soft">{selected.items.map((item, i) => <RankingRow key={`${item.rank}-${i}`} item={item} judgement={byRank.get(item.rank)?.title === item.title ? byRank.get(item.rank) : undefined} />)}</ol>}
        </>}
      </main>
    </div>
  </div>;
}
