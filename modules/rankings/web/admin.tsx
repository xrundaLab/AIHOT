import { Link } from "react-router";
import { adminGet } from "@aihot/web/lib/admin.server";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable } from "@aihot/web/features/admin/ui";

type Source = { id: string; participation_mode: string; tier: string; updated_at: string; enabled: boolean };
type Task = { id: string; title: string; url: string | null; origin: string; state: string; error: string | null; article_id: string | null; processing_state: string | null; visibility: string | null };
type RadarAdmin = { source: Source | null; counts: Array<{ state: string; count: number }>; tasks: Task[] };
export async function loader({ request }: { request: Request }) { return adminGet<RadarAdmin>(request, "/api/admin/radar"); }
const labels: Record<string, string> = { pending: "待抓取", running: "抓取中", external: "等待外部补采", leased: "外部抓取中", complete: "已获取正文", manual: "待人工处理" };
export default function RadarAdminPage({ loaderData }: { loaderData: RadarAdmin }) {
  const { source, tasks, counts } = loaderData;
  const { run, busy } = useAdminAction();
  const enabled = source?.participation_mode === "editorial";
  const toggle = async () => {
    if (!source) return;
    await run("PATCH", `/api/admin/sources/${source.id}`, { version: source.updated_at, patch: { participation_mode: enabled ? "isolated" : "editorial", tier: "EXCLUDE_MP" }, reason: enabled ? "关闭雷达动态发布" : "开启雷达动态发布" }, { success: "设置已更新" });
  };
  return <AdminPage title="热文雷达" subtitle="查看雷达正文处理状态，管理进入动态的文章。">
    <Card title="动态发布" right={source ? <Button tone={enabled ? "danger" : "primary"} disabled={busy || !source.enabled} onClick={toggle}>{enabled ? "关闭自动发布" : "开启自动发布"}</Button> : undefined}>
      <p className="text-sm text-ink-3">{!source ? "首条雷达线索完成判断后自动创建信源。" : enabled ? "已开启：新发现文章完成分析并符合公开规则后进入动态。" : "已关闭：新发现文章不会自动进入公开动态。"}</p>
      {source && !source.enabled && <p className="mt-2 text-sm text-ink-3">信源已暂停，请先到<Link to={`/admin/sources/${source.id}`} className="text-accent">信源设置</Link>启用。</p>}
      <p className="mt-2 text-sm text-ink-3">关闭会撤回该信源已公开的文章；已属于其他信源的文章不受影响。雷达聚合信源仅展示摘要；其他信源的全文仍由其授权控制。</p>
    </Card>
    <div className="my-4 flex flex-wrap gap-2">{counts.map(c => <Badge key={c.state}>{labels[c.state] ?? c.state} {c.count}</Badge>)}</div>
    <Card title="最近 100 条线索" pad={false}>
      <DataTable rows={tasks} rowKey={t => t.id} empty="暂无雷达线索" columns={[
        { key: "title", label: "标题", render: t => <div className="min-w-[260px]">{t.article_id ? <Link className="text-accent" to={`/admin/content/${t.article_id}`}>{t.title}</Link> : t.title}<div className="text-xs text-ink-4">{t.origin}{t.url && <> · <a href={t.url} target="_blank" rel="noreferrer" className="text-accent">原文 ↗</a></>}</div></div> },
        { key: "state", label: "正文", render: t => <span><Badge>{labels[t.state] ?? t.state}</Badge>{t.error && <span className="ml-2 text-xs text-ink-4">{t.error}</span>}</span> },
        { key: "publication", label: "处理 / 公开", render: t => `${t.processing_state ?? "—"} / ${t.visibility ?? "—"}` },
        { key: "action", label: "操作", render: t => t.state === "external" ? <Button size="sm" disabled={busy} onClick={() => void run("POST", `/api/admin/radar/tasks/${t.id}/retry`, {}, { success: "已安排重试" })}>重试抓取</Button> : null },
      ]} />
    </Card>
  </AdminPage>;
}
