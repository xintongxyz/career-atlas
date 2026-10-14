import type { CalendarItem, CompanyDTO, EventDTO } from "@shared/types";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Download, Plus } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { displayCompany, displayTitle } from "@/components/jobs/badges";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Card, EmptyState, Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/tabs";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs } from "@/hooks/useJobMutations";
import { useLocaleContext } from "@/hooks/useMe";
import { api, qs } from "@/lib/api";
import { formatDate, formatDateTime, fromDateInput, fromDateTimeInput, zonedYmd } from "@/lib/format";
import { cn, downloadBlob } from "@/lib/utils";
import { calendarItemLabel, eventText } from "./dashboard";
import { PageHeader } from "./system";

const KIND_STYLE: Record<CalendarItem["kind"], string> = {
  applied: "bg-accent-soft text-accent",
  follow_up: "bg-warn-soft text-warn",
  interview: "bg-violet-soft text-violet",
  deadline: "bg-danger-soft text-danger",
  offer_deadline: "bg-ok-soft text-ok",
  reminder: "bg-info-soft text-info",
};

export default function CalendarPage() {
  const { t } = useLocaleContext();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as "month" | "list" | "timeline") || "month";
  return (
    <div>
      <PageHeader
        title={t("calendar.title")}
        actions={
          <Segmented
            label={t("calendar.title")}
            value={view}
            onChange={(v) => setParams(v === "month" ? {} : { view: v }, { replace: true })}
            options={[
              { value: "month", label: t("calendar.month") },
              { value: "list", label: t("calendar.list") },
              { value: "timeline", label: t("calendar.timeline") },
            ]}
          />
        }
      />
      {view === "timeline" ? <Timeline /> : <CalendarView view={view} />}
    </div>
  );
}

function CalendarView({ view }: { view: "month" | "list" }) {
  const { t, lang, tz } = useLocaleContext();
  const onError = useToastError();
  const today = zonedYmd(Date.now(), tz);
  const [cursor, setCursor] = React.useState({ y: today.y, m: today.m });
  const [creating, setCreating] = React.useState<string | null>(null);
  const first = fromDateInput(`${cursor.y}-${String(cursor.m).padStart(2, "0")}-01`, tz, "00:00")!;
  const nextMonth = cursor.m === 12 ? { y: cursor.y + 1, m: 1 } : { y: cursor.y, m: cursor.m + 1 };
  const last = fromDateInput(`${nextMonth.y}-${String(nextMonth.m).padStart(2, "0")}-01`, tz, "00:00")! - 1;
  const range = view === "list" ? { from: Date.now() - 30 * 86_400_000, to: Date.now() + 60 * 86_400_000 } : { from: first - 7 * 86_400_000, to: last + 7 * 86_400_000 };
  const q = useQuery({ queryKey: ["calendar", range.from, range.to], queryFn: () => api.get<{ items: CalendarItem[] }>(`/api/calendar${qs({ from: range.from, to: range.to })}`) });
  const items = q.data?.items ?? [];
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (i: CalendarItem) => api.patch(`/api/reminders/${i.reminder_id}`, { completed: !i.completed }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["calendar"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError,
  });
  const downloadIcs = async () => {
    try {
      const blob = await api.download(`/api/calendar.ics${qs({ from: range.from, to: range.to, lang })}`);
      downloadBlob(blob, "career-atlas.ics");
    } catch (e) {
      onError(e);
    }
  };
  const monthLabel = new Intl.DateTimeFormat(lang, { year: "numeric", month: "long", timeZone: "UTC" }).format(Date.UTC(cursor.y, cursor.m - 1, 15));

  const toolbar = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {view === "month" ? (
        <>
          <Button variant="ghost" size="icon" aria-label={t("common.previous")} onClick={() => setCursor((c) => (c.m === 1 ? { y: c.y - 1, m: 12 } : { y: c.y, m: c.m - 1 }))}>
            <ChevronLeft />
          </Button>
          <h2 className="min-w-36 text-center text-[15px] font-semibold">{monthLabel}</h2>
          <Button variant="ghost" size="icon" aria-label={t("common.next")} onClick={() => setCursor(nextMonth)}>
            <ChevronRight />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCursor({ y: today.y, m: today.m })}>
            {t("calendar.todayBtn")}
          </Button>
        </>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Legend />
        <Button variant="secondary" onClick={() => setCreating("")}>
          <Plus />
          {t("actions.addReminder")}
        </Button>
        <Button variant="secondary" onClick={downloadIcs}>
          <Download />
          {t("actions.downloadIcs")}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {toolbar}
      <p className="mb-3 text-xs text-ink-4">{t("reminders.followUpNote")}</p>
      {q.isLoading ? <Skeleton className="h-[32rem]" /> : view === "month" ? <MonthGrid cursor={cursor} items={items} onDayClick={(d) => setCreating(d)} onToggle={(i) => toggle.mutate(i)} /> : <AgendaList items={items} onToggle={(i) => toggle.mutate(i)} />}
      <ReminderDialog date={creating} onClose={() => setCreating(null)} />
    </>
  );
}

function Legend() {
  const { t } = useLocaleContext();
  return (
    <div className="hidden flex-wrap gap-1.5 md:flex">
      {(Object.keys(KIND_STYLE) as CalendarItem["kind"][]).map((k) => (
        <span key={k} className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", KIND_STYLE[k])}>
          {t(`calendar.kinds.${k}`)}
        </span>
      ))}
    </div>
  );
}

function MonthGrid({ cursor, items, onDayClick, onToggle }: { cursor: { y: number; m: number }; items: CalendarItem[]; onDayClick: (date: string) => void; onToggle: (i: CalendarItem) => void }) {
  const { t, tz } = useLocaleContext();
  const today = zonedYmd(Date.now(), tz);
  const firstDow = new Date(Date.UTC(cursor.y, cursor.m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(cursor.y, cursor.m, 0)).getUTCDate();
  const cells: ({ d: number; key: string } | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => ({ d: i + 1, key: `${cursor.y}-${String(cursor.m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}` }))];
  while (cells.length % 7) cells.push(null);
  const byDay = new Map<string, CalendarItem[]>();
  for (const i of items) {
    const { y, m, d } = zonedYmd(i.at, tz);
    const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    byDay.set(key, [...(byDay.get(key) ?? []), i]);
  }
  const weekdays = t("calendar.weekdays").split(",");
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-line bg-subtle/50 text-center text-[11px] font-medium text-ink-3">
        {weekdays.map((w) => (
          <div key={w} className="py-1.5">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((c, idx) => {
          const list = c ? byDay.get(c.key) ?? [] : [];
          const isToday = c && cursor.y === today.y && cursor.m === today.m && c.d === today.d;
          return (
            <div key={idx} className={cn("min-h-24 border-b border-r border-line p-1 sm:min-h-28", !c && "bg-canvas/60", idx % 7 === 6 && "border-r-0")}>
              {c ? (
                <>
                  <button type="button" onClick={() => onDayClick(c.key)} className={cn("mb-0.5 flex size-6 items-center justify-center rounded-full text-xs tabular hover:bg-subtle", isToday ? "bg-accent font-semibold text-accent-ink hover:bg-accent" : "text-ink-3")} aria-label={`${t("actions.addReminder")} ${c.key}`}>
                    {c.d}
                  </button>
                  <ul className="space-y-0.5">
                    {list.slice(0, 4).map((i) => (
                      <li key={i.id}>
                        <CalendarChip item={i} onToggle={onToggle} />
                      </li>
                    ))}
                    {list.length > 4 ? <li className="px-1 text-[10px] text-ink-4">+{list.length - 4}</li> : null}
                  </ul>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CalendarChip({ item, onToggle }: { item: CalendarItem; onToggle: (i: CalendarItem) => void }) {
  const { t, lang, tz } = useLocaleContext();
  const label = `${calendarItemLabel(item, t)}${item.company_name ? ` · ${displayCompany(item.company_name, t)}` : ""}`;
  const body = (
    <span className={cn("flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] font-medium leading-tight sm:text-[11px]", KIND_STYLE[item.kind], item.completed && "line-through opacity-50")} title={`${formatDateTime(item.at, lang, tz)} — ${label}`}>
      {item.reminder_id ? (
        <span
          role="checkbox"
          aria-checked={!!item.completed}
          tabIndex={0}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggle(item);
          }}
          onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), onToggle(item))}
          className="inline-flex size-3 shrink-0 items-center justify-center rounded-sm border border-current"
          aria-label={t("actions.done")}
        >
          {item.completed ? <Check className="size-2.5" /> : null}
        </span>
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
  return item.saved_job_id ? <Link to={`/jobs/${item.saved_job_id}`}>{body}</Link> : body;
}

function AgendaList({ items, onToggle }: { items: CalendarItem[]; onToggle: (i: CalendarItem) => void }) {
  const { t, lang, tz } = useLocaleContext();
  if (!items.length) return <Card><EmptyState title={t("calendar.noItems")} /></Card>;
  const groups = new Map<string, CalendarItem[]>();
  for (const i of items) {
    const key = formatDate(i.at, lang, tz, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const now = Date.now();
  return (
    <Card className="divide-y divide-line">
      {[...groups.entries()].map(([day, list]) => (
        <section key={day} className="px-4 py-3">
          <h3 className={cn("mb-1.5 text-xs font-semibold", list[0].at < now - 86_400_000 ? "text-ink-4" : "text-ink-2")}>{day}</h3>
          <ul className="space-y-1.5">
            {list.map((i) => (
              <li key={i.id} className="flex items-center gap-3 text-[13px]">
                <span className="w-14 shrink-0 text-xs tabular text-ink-4">{formatDate(i.at, lang, tz, { hour: "numeric", minute: "2-digit" })}</span>
                <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium", KIND_STYLE[i.kind])}>{t(`calendar.kinds.${i.kind}`)}</span>
                <span className={cn("min-w-0 flex-1 truncate", i.completed && "text-ink-4 line-through")}>
                  {calendarItemLabel(i, t)}
                  {i.saved_job_id ? (
                    <Link to={`/jobs/${i.saved_job_id}`} className="ml-2 text-xs text-ink-3 hover:text-ink">
                      {displayCompany(i.company_name, t)} · {displayTitle(i.job_title, t)}
                    </Link>
                  ) : null}
                </span>
                {i.reminder_id ? (
                  <Button size="sm" variant="ghost" onClick={() => onToggle(i)}>
                    {i.completed ? t("reminders.reopened") : t("actions.done")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}

function ReminderDialog({ date, onClose }: { date: string | null; onClose: () => void }) {
  const { t, tz } = useLocaleContext();
  const invalidate = useInvalidateJobs();
  const onError = useToastError();
  const [title, setTitle] = React.useState("");
  const [kind, setKind] = React.useState("custom");
  const [due, setDue] = React.useState("");
  React.useEffect(() => {
    if (date !== null) {
      setTitle("");
      setDue(date ? `${date}T09:00` : "");
    }
  }, [date]);
  const create = useMutation({
    mutationFn: () => api.post("/api/reminders", { title, kind, due_at: fromDateTimeInput(due, tz) }),
    onSuccess: () => {
      toast.success(t("reminders.created"));
      void invalidate();
      onClose();
    },
    onError,
  });
  return (
    <Dialog open={date !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t("reminders.createTitle")} size="sm">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t("reminders.titleLabel")} htmlFor="rm-title">
            <Input id="rm-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} autoFocus />
          </Field>
          <Field label={t("fields.status")} htmlFor="rm-kind">
            <NativeSelect id="rm-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {["custom", "follow_up", "interview", "deadline", "apply"].map((k) => (
                <option key={k} value={k}>
                  {t(`reminders.kind.${k}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("reminders.dueLabel")} htmlFor="rm-due">
            <Input id="rm-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} required />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!title || !due || create.isPending}>
              {t("actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Timeline() {
  const { t, lang, tz } = useLocaleContext();
  const [company, setCompany] = React.useState("");
  const companies = useQuery({ queryKey: ["companies"], queryFn: () => api.get<{ items: CompanyDTO[] }>("/api/companies") });
  const events = useInfiniteQuery({
    queryKey: ["events", "timeline", company],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.get<{ items: EventDTO[] }>(`/api/events${qs({ company_id: company || undefined, before: pageParam, limit: 100 })}`),
    getNextPageParam: (last) => (last.items.length === 100 ? last.items[last.items.length - 1].occurred_at : undefined),
  });
  const all = events.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = new Map<string, EventDTO[]>();
  for (const e of all) {
    const key = formatDate(e.occurred_at, lang, tz, { year: "numeric", month: "long", day: "numeric", weekday: "short" });
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return (
    <div className="space-y-3">
      <NativeSelect className="w-64" value={company} onChange={(e) => setCompany(e.target.value)} aria-label={t("calendar.filterCompany")}>
        <option value="">{t("calendar.filterCompany")}</option>
        {companies.data?.items.filter((c) => (c.job_count ?? 0) > 0).map((c) => (
          <option key={c.id} value={c.id}>
            {displayCompany(c.name, t)}
          </option>
        ))}
      </NativeSelect>
      {events.isLoading ? (
        <Skeleton className="h-96" />
      ) : !all.length ? (
        <Card>
          <EmptyState title={t("calendar.timelineEmpty")} />
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {[...groups.entries()].map(([day, list]) => (
            <section key={day} className="grid gap-2 px-4 py-3 sm:grid-cols-[11rem_1fr]">
              <h3 className="text-xs font-semibold text-ink-3">{day}</h3>
              <ul className="space-y-1.5">
                {list.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2 text-[13px]">
                    <span className="w-12 shrink-0 text-xs tabular text-ink-4">{formatDate(e.occurred_at, lang, tz, { hour: "numeric", minute: "2-digit" })}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-ink">{eventText(e, t)}</span>{" "}
                      <Link to={`/jobs/${e.saved_job_id}`} className="text-xs text-ink-3 hover:text-ink">
                        {displayCompany(e.company_name, t)} · {displayTitle(e.job_title, t)}
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {events.hasNextPage ? (
            <div className="p-3 text-center">
              <Button variant="ghost" onClick={() => events.fetchNextPage()} disabled={events.isFetchingNextPage}>
                {t("calendar.loadMore")}
              </Button>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
