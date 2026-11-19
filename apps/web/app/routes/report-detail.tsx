import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/report-detail";
import { REPORT_NAMES, type ReportDetail, type ReportNavigationResponse, type ReportKind } from "@aihot/contracts/site";
import { SITE, subjectAfter } from "@aihot/site";
import { apiGet, cachedPage, loadOr404 } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { pageMeta, reportLd, reportTitle, titled } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper, reportOutline } from "../features/report/ReportPaper";
import { feedLink, kindFromPath } from "../features/report/format";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "daily", name: "日报" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

const PATTERN: Record<ReportKind, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-W\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const key = params.key ?? "";
  if (!PATTERN[kind].test(key)) throw data({ message: "not_found" }, { status: 404 });
  const revision = (params as { revision?: string }).revision;
  const suffix = revision ? `/history/${encodeURIComponent(revision)}` : "";
  const [report, { items: index }] = await Promise.all([
    loadOr404<ReportDetail>(`/api/site/reports/${kind}/${key}${suffix}`, { signal: request.signal }),
    apiGet<ReportNavigationResponse>(`/api/site/reports/${kind}/navigation/${key}`, { signal: request.signal }),
  ]);
  return cachedPage(revision ? 0 : 3600, { report, index, revision, today: beijingDate(Date.now()) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("报告不存在") }, { name: "robots", content: "noindex" }];
  const r = loaderData.report;
  if (loaderData.revision) return [{ title: titled(`${r.title} · 历史版本`) }, { name: "robots", content: "noindex" }];
  const description = r.lead?.leadParagraph ?? r.overview?.slice(0, 150) ?? `${SITE.name} ${r.key} ${subjectAfter("的", REPORT_NAMES[r.kind])}。`;
  const path = `/${r.kind}/${r.key}`;
  return [...pageMeta({
    title: reportTitle(r),
    description,
    path,
    image: `/og/reports/${r.kind}/${r.key}.png`,
    type: "article",
    jsonLd: reportLd(r, path, description),
  }), feedLink(r.kind)];
}

export default function ReportDetailPage() {
  const { report, index, today, revision } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={report.kind} index={index} current={report.key} today={today} outline={reportOutline(report)}>
      <ReportPaper report={report} index={index} historical={!!revision} />
    </ReportLayout>
  );
}
