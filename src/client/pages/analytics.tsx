import type { AnalyticsDTO, Ratio } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Input, NativeSelect } from "@/components/ui/input";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/overlay";
import { Segmented } from "@/components/ui/tabs";
import { useLocaleContext } from "@/hooks/useMe";
import { api, qs } from "@/lib/api";
import { formatNumber, formatPercent, fromDateInput } from "@/lib/format";
import { PageHeader } from "./system";

// Validated two-series palette (lightness band, chroma, CVD and contrast checks pass).
const SERIES = { applied: "#0b8f78", saved: "#c0702a" };
type RangeKey = "all" | "30" | "90" | "180" | "365" | "custom";

export default function AnalyticsPage() {
  const { t, lang, tz } = useLocaleContext();
  const [range, setRange] = React.useState<RangeKey>("all");
  const [custom, setCustom] = React.useState({ from: "", to: "" });
  const [bucket, setBucket] = React.useState<"week" | "month">("week");
  const [segment, setSegment] = React.useState<keyof AnalyticsDTO["segments"]>("work_mode");
  const params = React.useMemo(() => {
    if (range === "all") return {};
    if (range === "custom") return { from: fromDateInput(custom.from, tz, "00:00") ?? undefined, to: fromDateInput(custom.to, tz, "23:59") ?? undefined };
    return { from: Date.now() - Number(range) * 86_400_000, to: Date.now() };
  }, [range, custom, tz]);
  const q = useQuery({ queryKey: ["analytics", params], queryFn: () => api.get<AnalyticsDTO>(`/api/analytics${qs(params)}`) });
  const d = q.data;
  const series = d ? (bucket === "week" ? d.by_week : d.by_month) : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("analytics.title")}
        subtitle={t("analytics.subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect className="w-40" aria-label={t("analytics.range")} value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
              {(["all", "30", "90", "180", "365", "custom"] as RangeKey[]).map((r) => (
                <option key={r} value={r}>
                  {t(`analytics.ranges.${r}`)}
                </option>
              ))}
            </NativeSelect>
            {range === "custom" ? (
              <>
                <Input type="date" className="w-36" aria-label={t("common.from")} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
                <Input type="date" className="w-36" aria-label={t("common.to")} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </>
            ) : null}
          </div>
        }
      />
      <p className="text-xs text-ink-3">
        {t("analytics.cohortNote")} {t("analytics.milestoneNote")}
      </p>
      {q.isError ? <ErrorState message={t("common.loadingFailed")} onRetry={() => q.refetch()} retryLabel={t("actions.retry")} /> : null}
      {q.isLoading ? (
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : d && d.totals.applied === 0 && d.totals.saved === 0 ? (
        <Card>
          <EmptyState title={t("common.insufficientData")} body={t("analytics.noData")} />
        </Card>
      ) : d ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            {(Object.keys(d.totals) as (keyof AnalyticsDTO["totals"])[])
              .filter((k) => k !== "assessments")
              .map((k) => (
                <div key={k} className="rounded-lg border border-line bg-surface p-3 shadow-card">
                  <p className="truncate text-xs text-ink-3">{t(`analytics.metrics.${k}`)}</p>
                  <p className="mt-1 text-xl font-semibold tabular">{formatNumber(d.totals[k], lang)}</p>
                </div>
              ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {(Object.keys(d.rates) as (keyof AnalyticsDTO["rates"])[]).map((k) => (
              <RateTile key={k} name={k} ratio={d.rates[k]} />
            ))}
          </div>
          <p className="text-xs text-ink-4">{t("analytics.effectiveDef")}</p>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader
                title={bucket === "week" ? t("analytics.byWeek") : t("analytics.byMonth")}
                action={
                  <Segmented
                    value={bucket}
                    onChange={setBucket}
                    options={[
                      { value: "week", label: t("analytics.byWeek") },
                      { value: "month", label: t("analytics.byMonth") },
                    ]}
                  />
                }
              />
              <div className="h-64 px-2 pb-3">
                {series.length < 2 ? (
                  <p className="flex h-full items-center justify-center text-[13px] text-ink-4">{t("common.insufficientData")}</p>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={series} barGap={2} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid vertical={false} stroke="var(--color-line)" strokeDasharray="0" />
                      <XAxis dataKey="period" tick={{ fontSize: 11, fill: "var(--color-ink-3)" }} axisLine={{ stroke: "var(--color-line)" }} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--color-ink-3)" }} axisLine={false} tickLine={false} />
                      <RTooltip cursor={{ fill: "var(--color-subtle)" }} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid var(--color-line)", boxShadow: "var(--shadow-pop)" }} />
                      <Legend wrapperStyle={{ fontSize: 12, color: "var(--color-ink-2)" }} iconType="circle" iconSize={8} />
                      <Bar dataKey="applied" name={t("analytics.seriesApplied")} fill={SERIES.applied} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                      <Bar dataKey="saved" name={t("analytics.seriesSaved")} fill={SERIES.saved} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
              <details className="border-t border-line px-4 py-2 text-xs text-ink-3">
                <summary className="cursor-pointer">{t("analytics.segCols.key")} · {t("analytics.count")}</summary>
                <table className="mt-2 w-full tabular">
                  <thead>
                    <tr className="text-left text-ink-4">
                      <th className="py-1 font-medium">{t("analytics.segCols.key")}</th>
                      <th className="py-1 font-medium">{t("analytics.seriesApplied")}</th>
                      <th className="py-1 font-medium">{t("analytics.seriesSaved")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {series.map((s) => (
                      <tr key={s.period} className="border-t border-line/60">
                        <td className="py-1">{s.period}</td>
                        <td className="py-1">{s.applied}</td>
                        <td className="py-1">{s.saved}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </Card>

            <Card>
              <CardHeader title={t("analytics.byStatus")} />
              <div className="px-4 pb-4">
                {d.by_status.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-ink-4">{t("common.insufficientData")}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {[...d.by_status]
                      .sort((a, b) => b.count - a.count)
                      .map((s) => {
                        const max = Math.max(...d.by_status.map((x) => x.count));
                        return (
                          <li key={s.status} className="grid grid-cols-[7.5rem_1fr_2rem] items-center gap-2 text-[13px]">
                            <span className="truncate text-ink-2">{t(`status.${s.status}`)}</span>
                            <span className="h-2 overflow-hidden rounded-full bg-subtle" title={`${t(`status.${s.status}`)}: ${s.count}`}>
                              <span className="block h-full rounded-full" style={{ width: `${(s.count / max) * 100}%`, background: SERIES.applied }} />
                            </span>
                            <span className="text-right tabular">{s.count}</span>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </div>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader title={t("analytics.time")} />
              <dl className="space-y-3 px-4 pb-4 text-[13px]">
                <TimeStat label={t("analytics.firstResponse")} count={d.time.first_response_days.count} avg={d.time.first_response_days.average} median={d.time.first_response_days.median} />
                <TimeStat label={t("analytics.openAge")} count={d.time.open_applications_age_days.count} median={d.time.open_applications_age_days.median} />
                <div className="flex justify-between border-t border-line pt-2">
                  <dt className="text-ink-3">{t("analytics.overdueFollowUps")}</dt>
                  <dd className="font-medium tabular">{d.time.overdue_follow_ups}</dd>
                </div>
              </dl>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader title={t("analytics.stageTime")} />
              <div className="overflow-x-auto px-4 pb-4">
                {d.time.stage_days.length === 0 ? (
                  <p className="py-4 text-center text-[13px] text-ink-4">{t("common.insufficientData")}</p>
                ) : (
                  <table className="w-full text-[13px] tabular">
                    <thead className="text-left text-xs text-ink-3">
                      <tr>
                        <th className="py-1.5 font-medium">{t("fields.status")}</th>
                        <th className="py-1.5 font-medium">{t("analytics.count")}</th>
                        <th className="py-1.5 font-medium">{t("analytics.average")}</th>
                        <th className="py-1.5 font-medium">{t("analytics.median")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {d.time.stage_days.map((s) => (
                        <tr key={s.status}>
                          <td className="py-1.5">{t(`status.${s.status}`)}</td>
                          <td className="py-1.5">{s.count}</td>
                          <td className="py-1.5">{s.average != null ? t("analytics.days", { count: s.average }) : "—"}</td>
                          <td className="py-1.5">{s.median != null ? t("analytics.days", { count: s.median }) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader
              title={t("analytics.segments")}
              action={
                <NativeSelect className="w-44" value={segment} onChange={(e) => setSegment(e.target.value as keyof AnalyticsDTO["segments"])} aria-label={t("analytics.segments")}>
                  {(Object.keys(d.segments) as (keyof AnalyticsDTO["segments"])[]).map((k) => (
                    <option key={k} value={k}>
                      {t(`analytics.segment.${k}`)}
                    </option>
                  ))}
                </NativeSelect>
              }
            />
            <div className="overflow-x-auto px-4 pb-4">
              <table className="w-full min-w-[520px] text-[13px] tabular">
                <thead className="text-left text-xs text-ink-3">
                  <tr>
                    {(["key", "applied", "responses", "interviews", "offers", "rate"] as const).map((c) => (
                      <th key={c} className="py-1.5 font-medium">
                        {t(`analytics.segCols.${c}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.segments[segment].map((s) => (
                    <tr key={s.key}>
                      <td className="py-1.5">{segmentLabel(segment, s.key, t)}</td>
                      <td className="py-1.5">{s.applied}</td>
                      <td className="py-1.5">{s.responses}</td>
                      <td className="py-1.5">{s.interviews}</td>
                      <td className="py-1.5">{s.offers}</td>
                      <td className="py-1.5">
                        {formatPercent(s.applied ? s.interviews / s.applied : null, lang)}
                        {s.applied < 5 ? <span className="ml-1 text-[11px] text-ink-4">({t("common.smallSample")})</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function segmentLabel(seg: string, key: string, t: (k: string) => string) {
  if (key === "unknown") return t("common.unknown");
  if (seg === "work_mode") return t(`workMode.${key}`);
  if (seg === "source") return t(`platform.${key}`);
  return key;
}

function RateTile({ name, ratio }: { name: keyof AnalyticsDTO["rates"]; ratio: Ratio }) {
  const { t, lang } = useLocaleContext();
  const insufficient = ratio.value == null;
  return (
    <div className="rounded-lg border border-line bg-surface p-3.5 shadow-card">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-ink-3">{t(`analytics.rates.${name}`)}</p>
        <Tooltip content={t(`analytics.rateDefs.${name}`)}>
          <button type="button" aria-label={t(`analytics.rateDefs.${name}`)} className="text-ink-4 hover:text-ink">
            <Info className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <p className="mt-1 text-2xl font-semibold tabular">{insufficient ? <span className="text-base font-medium text-ink-4">{t("common.insufficientData")}</span> : formatPercent(ratio.value, lang)}</p>
      <p className="mt-0.5 text-xs text-ink-3 tabular">
        {t("analytics.fraction", { num: ratio.numerator, den: ratio.denominator })}
        {!insufficient && ratio.denominator < 5 ? <span className="ml-1 text-ink-4">· {t("common.smallSample")}</span> : null}
      </p>
    </div>
  );
}

function TimeStat({ label, count, avg, median }: { label: string; count: number; avg?: number | null; median: number | null }) {
  const { t } = useLocaleContext();
  return (
    <div>
      <dt className="text-ink-3">{label}</dt>
      <dd className="mt-0.5">
        {count === 0 ? (
          <span className="text-ink-4">{t("common.insufficientData")}</span>
        ) : (
          <span className="tabular">
            {avg !== undefined ? `${t("analytics.average")} ${avg != null ? t("analytics.days", { count: avg }) : "—"} · ` : ""}
            {t("analytics.median")} {median != null ? t("analytics.days", { count: median }) : "—"} <span className="text-xs text-ink-4">(n={count})</span>
          </span>
        )}
      </dd>
    </div>
  );
}
