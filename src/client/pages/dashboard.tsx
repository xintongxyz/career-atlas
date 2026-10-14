import type { PipelineStatus } from "@shared/constants";
import type { CalendarItem, DashboardDTO, EventDTO } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BellRing, Briefcase, CalendarClock, Inbox, Link2, MessageSquareReply, Send, Sparkles, Trophy } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { STATUS_DOT, displayCompany, displayTitle } from "@/components/jobs/badges";
import { useQuickAdd } from "@/components/layout/quick-add-context";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/overlay";
import { useLocaleContext } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { formatDateTime, formatRelative, formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function DashboardPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<DashboardDTO>("/api/dashboard") });
  const d = q.data;
  const empty = d && d.counts.saved_total === 0 && d.counts.applications_total === 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t("dashboard.title")}</h1>
        <p className="text-[13px] text-ink-3">{t("dashboard.greeting")}</p>
      </div>
      <QuickAddHero />
      {q.isError ? <ErrorState message={t("common.loadingFailed")} onRetry={() => q.refetch()} retryLabel={t("actions.retry")} /> : null}
      {d?.counts.needs_review ? (
        <Link to="/positions?needs_review=true" className="flex items-center gap-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-warn hover:border-warn/50">
          <Sparkles className="size-4" />
          <span className="flex-1">{t("dashboard.needsReview", { count: d.counts.needs_review })}</span>
          <ArrowRight className="size-4" />
        </Link>
      ) : null}
      <StatCards data={d} loading={q.isLoading} />
      {empty ? (
        <Card>
          <EmptyState icon={<Briefcase />} title={t("dashboard.emptyTitle")} body={t("dashboard.emptyBody")} />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            <Pipeline data={d} loading={q.isLoading} />
            <RecentActivity events={d?.recent_events} loading={q.isLoading} />
          </div>
          <Upcoming upcoming={d?.upcoming} overdue={d?.overdue} loading={q.isLoading} />
        </div>
      )}
    </div>
  );
}

function QuickAddHero() {
  const { t } = useTranslation();
  const quickAdd = useQuickAdd();
  const [url, setUrl] = React.useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        quickAdd.open({ url: url.trim(), tab: "url", autoSubmit: /^https?:\/\//i.test(url.trim()) });
        setUrl("");
      }}
      className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5"
    >
      <label htmlFor="hero-url" className="text-[15px] font-semibold text-ink">
        {t("quickAdd.heroTitle")}
      </label>
      <p className="mt-0.5 text-xs text-ink-3">{t("quickAdd.heroHelp")}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Link2 className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-4" />
          <input
            id="hero-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData("text").trim();
              if (/^https?:\/\//i.test(pasted)) {
                e.preventDefault();
                quickAdd.open({ url: pasted, tab: "url", autoSubmit: true });
              }
            }}
            placeholder={t("quickAdd.urlPlaceholder")}
            className="h-10 w-full rounded-lg border border-line bg-canvas pl-9 pr-3 text-[13px] placeholder:text-ink-4 focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
        </div>
        <Button type="submit" variant="primary" size="lg">
          {t("quickAdd.saveAndExtract")}
        </Button>
      </div>
      <div className="mt-2 flex gap-3 text-xs">
        <button type="button" className="text-ink-3 hover:text-ink" onClick={() => quickAdd.open({ tab: "paste" })}>
          {t("quickAdd.tabPaste")}
        </button>
        <span className="text-ink-4">·</span>
        <button type="button" className="text-ink-3 hover:text-ink" onClick={() => quickAdd.open({ tab: "manual" })}>
          {t("quickAdd.tabManual")}
        </button>
      </div>
    </form>
  );
}

const CARDS: { key: keyof DashboardDTO["counts"]; icon: React.ElementType; to: string }[] = [
  { key: "saved_total", icon: Inbox, to: "/positions" },
  { key: "applications_total", icon: Send, to: "/applications" },
  { key: "awaiting_response", icon: MessageSquareReply, to: "/positions?status=applied,awaiting_response" },
  { key: "interviews", icon: CalendarClock, to: "/positions?status=interview" },
  { key: "offers", icon: Trophy, to: "/positions?status=offer,accepted" },
  { key: "follow_ups_due", icon: BellRing, to: "/calendar?view=list" },
];

function StatCards({ data, loading }: { data?: DashboardDTO; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {CARDS.map(({ key, icon: Icon, to }) => (
        <Link key={key} to={to} className="group rounded-lg border border-line bg-surface p-3.5 shadow-card transition-colors hover:border-line-strong">
          <div className="flex items-center justify-between">
            <Tooltip content={t(`dashboard.cardHelp.${key}`)}>
              <span className="truncate text-xs font-medium text-ink-3">{t(`dashboard.cards.${key}`)}</span>
            </Tooltip>
            <Icon className={cn("size-4 text-ink-4", key === "follow_ups_due" && (data?.counts.follow_ups_due ?? 0) > 0 && "text-warn")} />
          </div>
          {loading ? <Skeleton className="mt-2 h-7 w-12" /> : <p className="mt-1.5 text-2xl font-semibold tabular text-ink">{data?.counts[key] ?? 0}</p>}
        </Link>
      ))}
    </div>
  );
}

function Pipeline({ data, loading }: { data?: DashboardDTO; loading: boolean }) {
  const { t } = useTranslation();
  const stages = (data?.pipeline ?? []).filter((p) => p.status !== "archived");
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <Card>
      <CardHeader title={t("dashboard.pipeline")} description={t("dashboard.pipelineHelp")} />
      <div className="px-4 pb-4">
        {loading ? (
          <Skeleton className="h-40" />
        ) : (
          <ul className="space-y-1">
            {stages.map((s) => (
              <li key={s.status}>
                <Link to={`/positions?status=${s.status}`} className="group grid grid-cols-[8.5rem_1fr_2.5rem] items-center gap-3 rounded-md px-1.5 py-1 hover:bg-subtle sm:grid-cols-[10rem_1fr_3rem]">
                  <span className="flex items-center gap-2 truncate text-[13px] text-ink-2">
                    <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[s.status as PipelineStatus])} />
                    {t(`status.${s.status}`)}
                  </span>
                  <span className="h-2 overflow-hidden rounded-full bg-subtle">
                    <span className={cn("block h-full rounded-full", STATUS_DOT[s.status as PipelineStatus])} style={{ width: `${(s.count / max) * 100}%` }} />
                  </span>
                  <span className="text-right text-[13px] font-medium tabular text-ink">{s.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export function eventText(e: EventDTO, t: (k: string, o?: Record<string, unknown>) => string) {
  if (e.type === "status_changed") return t("events.status_changed", { from: e.from_status ? t(`status.${e.from_status}`) : "—", to: t(`status.${e.to_status}`) });
  return e.title && e.type === "custom" ? e.title : t(`events.${e.type}`);
}

function RecentActivity({ events, loading }: { events?: EventDTO[]; loading: boolean }) {
  const { t, lang, tz } = useLocaleContext();
  return (
    <Card>
      <CardHeader
        title={t("dashboard.recent")}
        action={
          <Link to="/calendar?view=timeline" className="text-xs font-medium text-accent hover:underline">
            {t("actions.viewAll")}
          </Link>
        }
      />
      <div className="px-4 pb-3">
        {loading ? (
          <Skeleton className="h-32" />
        ) : !events?.length ? (
          <p className="py-6 text-center text-[13px] text-ink-4">{t("dashboard.noActivity")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-2">
                <span className={cn("size-1.5 shrink-0 rounded-full", e.to_status ? STATUS_DOT[e.to_status as PipelineStatus] ?? "bg-ink-4" : "bg-ink-4")} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-ink">{eventText(e, t)}</p>
                  <Link to={`/jobs/${e.saved_job_id}`} className="block truncate text-xs text-ink-3 hover:text-ink">
                    {displayCompany(e.company_name, t)} · {displayTitle(e.job_title, t)}
                  </Link>
                </div>
                <time className="shrink-0 text-xs text-ink-4" dateTime={new Date(e.occurred_at).toISOString()} title={formatDateTime(e.occurred_at, lang, tz)}>
                  {formatRelative(e.occurred_at, lang)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

export function calendarItemLabel(i: CalendarItem, t: (k: string) => string) {
  if (i.kind === "reminder" || i.kind === "follow_up" || i.kind === "interview") {
    const key = `reminders.defaults.${i.title}`;
    const translated = t(key);
    return translated !== key ? translated : i.title || t(`calendar.kinds.${i.kind}`);
  }
  return t(`calendar.kinds.${i.kind}`);
}

function Upcoming({ upcoming, overdue, loading }: { upcoming?: CalendarItem[]; overdue?: CalendarItem[]; loading: boolean }) {
  const { t, lang, tz } = useLocaleContext();
  const row = (i: CalendarItem, late = false) => (
    <li key={i.id} className="flex items-start gap-3 py-2">
      <span className={cn("mt-0.5 w-14 shrink-0 text-xs tabular", late ? "font-medium text-warn" : "text-ink-3")}>{formatShortDate(i.at, lang, tz)}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">{calendarItemLabel(i, t)}</p>
        {i.saved_job_id ? (
          <Link to={`/jobs/${i.saved_job_id}`} className="block truncate text-xs text-ink-3 hover:text-ink">
            {displayCompany(i.company_name, t)} · {displayTitle(i.job_title, t)}
          </Link>
        ) : null}
      </div>
    </li>
  );
  return (
    <Card className="h-fit">
      <CardHeader
        title={t("dashboard.upcoming")}
        action={
          <Link to="/calendar" className="text-xs font-medium text-accent hover:underline">
            {t("actions.viewAll")}
          </Link>
        }
      />
      <div className="px-4 pb-3">
        {loading ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            {overdue?.length ? (
              <>
                <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-warn">{t("dashboard.overdue")}</p>
                <ul className="divide-y divide-line">{overdue.map((i) => row(i, true))}</ul>
              </>
            ) : null}
            {upcoming?.length ? <ul className="divide-y divide-line">{upcoming.map((i) => row(i))}</ul> : <p className="py-6 text-center text-[13px] text-ink-4">{t("dashboard.noUpcoming")}</p>}
          </>
        )}
      </div>
    </Card>
  );
}
