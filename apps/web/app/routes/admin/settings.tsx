import { ADMIN, SITE } from "@aihot/site";
import { useRef, useState } from "react";
import type { Route } from "./+types/settings";
import type { AdminSettings } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Input, ReasonDialog } from "../../features/admin/ui";
import { toast } from "../../features/admin/toast";


export async function loader({ request }: Route.LoaderArgs) {
  const [settings, ...prompts] = await Promise.all([
    adminGet<AdminSettings>(request, "/api/admin/settings"),
    ...promptNames.map(({ name }) => adminGet<PromptState>(request, `/api/admin/prompts/${name}`)),
  ]);
  return { ...settings, prompts };
}

export const meta: Route.MetaFunction = () => [{ title: `设置 · ${SITE.name} 后台` }];

function QrSlot({ slot, label, src }: { slot: "wechatQr" | "feishuQr"; label: string; src: string | null }) {
  const { run, pending } = useAdminAction();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-4">
      {src ? <img src={src} alt={label} className="size-28 rounded-card bg-white object-contain p-1.5 ring-1 ring-line" /> : <div className="flex size-28 shrink-0 items-center justify-center rounded-card bg-surface text-sm text-ink-4 ring-1 ring-line">未设置</div>}
      <div>
        <div className="text-[14px] font-medium text-ink">{label}</div>
        <div className="mt-0.5 break-all font-mono text-[11.5px] text-ink-4">{src}</div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) return toast("图片最大 2MB", "error");
            const image = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            await run("POST", "/api/admin/settings/contact-qr", { slot, image }, { label: `qr-${slot}`, success: `${label}已更换，关于页 5 分钟内更新` });
          }}
        />
        <Button className="mt-2" size="sm" busy={pending === `qr-${slot}`} onClick={() => input.current?.click()}>更换图片</Button>
      </div>
    </div>
  );
}

function BudgetRow({ b }: { b: AdminSettings["budgets"][number] }) {
  const { run, pending } = useAdminAction();
  const [v, setV] = useState({ perMinute: b.per_minute, perHour: b.per_hour, perDay: b.per_day });
  const [open, setOpen] = useState(false);
  const changed = v.perMinute !== b.per_minute || v.perHour !== b.per_hour || v.perDay !== b.per_day;
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-3 py-2 font-mono text-[12.5px]">{b.service}</td>
      {(["perMinute", "perHour", "perDay"] as const).map((k) => (
        <td key={k} className="px-3 py-2">
          <Input type="number" min={0} className="!w-24 !py-1 text-right" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
        </td>
      ))}
      <td className="num px-3 py-2 text-right text-ink-3">{num(b.used_hour)} / {num(b.used_day)}</td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" tone="primary" disabled={!changed} onClick={() => setOpen(true)}>保存</Button>
        <ReasonDialog
          open={open}
          title={`调整 ${b.service} 的请求上限`}
          description={`上限是付费请求的熔断：超过后请求暂停并按窗口重试。填 0 表示立即停用这个服务。${ADMIN.budgetNote ?? ""}`}
          confirmLabel="保存"
          busy={pending === "budget"}
          onClose={() => setOpen(false)}
          onSubmit={async (reason) => (await run("PUT", `/api/admin/budgets/${encodeURIComponent(b.service)}`, { ...v, reason }, { label: "budget", success: "上限已更新" })) !== null}
        />
      </td>
    </tr>
  );
}

function TargetToggle({ t }: { t: AdminSettings["targets"][number] }) {
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" tone={t.enabled ? "danger" : "primary"} onClick={() => setOpen(true)}>{t.enabled ? "停用" : "启用"}</Button>
      <ReasonDialog
        open={open}
        title={`${t.enabled ? "停用" : "启用"}：${t.note ?? t.key}`}
        description={t.enabled ? "停用后新的推送不再发往这个群。" : "启用时间会被记录：启用之前的内容不会补推。开发与彩排环境即使启用也不会真的发出。"}
        danger={t.enabled}
        confirmLabel={t.enabled ? "停用" : "启用"}
        busy={pending === "target"}
        onClose={() => setOpen(false)}
        onSubmit={async (reason) => (await run("POST", `/api/admin/notify-targets/${encodeURIComponent(t.key)}`, { enabled: !t.enabled, reason }, { label: "target", success: "已更新" })) !== null}
      />
    </>
  );
}

const promptNames = [
  { name: "daily-review", label: "日报适用性审核" },
  { name: "prefilter", label: "相关性预筛" },
  { name: "selection-score", label: "文章评分" },
] as const;

type PromptRevision = { text: string; at: string | null };
type PromptState = { current: PromptRevision; history: PromptRevision[] };

function PromptSettings({ state, name, label }: { state: PromptState; name: string; label: string }) {
  const { run, pending } = useAdminAction();
  const [draft, setDraft] = useState<{ text: string; expected: string | null } | null>(null);
  const download = () => {
    const url = URL.createObjectURL(new Blob([state.current.text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const preview = (text: string) => setDraft({ text, expected: state.current.at });
  return (
    <Card>
      <h3>{label}</h3>
      <p>{state.current.at ? bj(state.current.at) : "随部署提供的版本"}</p>
      <Button onClick={download}>下载当前 Markdown</Button>
      <label>上传 Markdown
        <input type="file" accept=".md,.markdown" onChange={async e => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (!file) return;
          if (file.size > 65536) return toast("提示词最大 64 KB", "error");
          try { preview(await file.text()); }
          catch { toast("无法读取文件", "error"); }
        }} />
      </label>
      {state.history.map((revision, i) => (
        <Button key={i} onClick={() => preview(revision.text)}>
          预览历史版本 {revision.at ? bj(revision.at) : "随部署提供的版本"}
        </Button>
      ))}
      {draft && <div>
        <details><summary>当前生效内容</summary><pre className="whitespace-pre-wrap">{state.current.text}</pre></details>
        <details open><summary>待发布内容</summary><pre className="whitespace-pre-wrap">{draft.text}</pre></details>
        <Button disabled={!!pending || draft.text === state.current.text} onClick={async () => {
          if (await run("POST", `/api/admin/prompts/${name}`, draft, { success: `${label}提示词已发布` })) setDraft(null);
        }}>确认发布</Button>
        <Button onClick={() => setDraft(null)}>取消</Button>
      </div>}
    </Card>
  );
}

export default function SettingsAdmin({ loaderData: s }: Route.ComponentProps) {
  return (
    <AdminPage title="设置" subtitle="不改代码即可替换的运营设置。每次修改都写入审计记录。">
      <section aria-label="提示词管理">
        <h2>提示词管理</h2>
        {promptNames.map((prompt, i) => <PromptSettings key={prompt.name} {...prompt} state={s.prompts[i]!} />)}
      </section>
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="关于页二维码">
          <div className="space-y-5">
            <QrSlot slot="wechatQr" label="微信公众号二维码" src={s.contact.wechatQr} />
            <QrSlot slot="feishuQr" label="飞书群二维码" src={s.contact.feishuQr} />
          </div>
        </Card>
        <Card title="通知目的地" pad={false}>
          <DataTable
            rows={s.targets}
            rowKey={(t) => t.key}
            columns={[
              { key: "k", label: "目的地", render: (t) => <div><div className="font-medium text-ink">{t.note ?? t.key}</div><div className="font-mono text-[11.5px] text-ink-4">{t.key} · {t.config_ref}</div></div> },
              { key: "e", label: "状态", render: (t) => (t.enabled ? <Badge tone="ok">启用于 {bj(t.enabled_at)}</Badge> : <Badge>停用</Badge>) },
              { key: "d", label: "7 天投递", align: "right", render: (t) => num(t.deliveries_7d) },
              { key: "a", label: "", align: "right", render: (t) => <TargetToggle t={t} /> },
            ]}
          />
        </Card>
      </div>
      <Card className="mt-5" title="付费请求上限" right={<span>已用：近 1 小时 / 近 24 小时</span>} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="px-3 py-2 font-medium">服务</th>
                <th className="px-3 py-2 font-medium">每分钟</th>
                <th className="px-3 py-2 font-medium">每小时</th>
                <th className="px-3 py-2 font-medium">每天</th>
                <th className="px-3 py-2 text-right font-medium">已用</th>
                <th />
              </tr>
            </thead>
            <tbody>{s.budgets.map((b) => <BudgetRow key={`${b.service}-${b.updated_at}`} b={b} />)}</tbody>
          </table>
        </div>
      </Card>
    </AdminPage>
  );
}
