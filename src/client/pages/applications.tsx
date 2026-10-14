import { BOARD_COLUMNS, BOARD_DROP_STATUS, SAVED_STAGES, type BoardColumnId, type PipelineStatus } from "@shared/constants";
import type { JobListItem, Paginated } from "@shared/types";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { localizedTitle } from "@/lib/job-i18n";
import { CompanyAvatar, PriorityBadge, SalaryText, StatusBadge, WorkModeBadge, displayCompany, displayTitle } from "@/components/jobs/badges";
import { JobCard } from "@/components/jobs/job-card";
import { StatusControl } from "@/components/jobs/status-control";
import { NativeSelect } from "@/components/ui/input";
import { Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/tabs";
import { useErrorMessage } from "@/hooks/useApiError";
import { JOB_QUERY_ROOTS } from "@/hooks/useJobMutations";
import { useLocaleContext } from "@/hooks/useMe";
import { api, qs } from "@/lib/api";
import { formatRelative, formatShortDate, locationText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "./system";

function columnOf(status: PipelineStatus): BoardColumnId | null {
  return BOARD_COLUMNS.find((c) => (c.statuses as readonly string[]).includes(status))?.id ?? null;
}

export default function ApplicationsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as "board" | "list") || "board";
  const company = params.get("company") ?? "";
  const workMode = params.get("work_mode") ?? "";
  const board = useQuery({ queryKey: ["board"], queryFn: () => api.get<{ items: JobListItem[] }>("/api/board") });
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const items = (board.data?.items ?? []).filter((j) => (!company || j.company_id === company) && (!workMode || j.work_mode === workMode));
  const companies = [...new Map((board.data?.items ?? []).map((j) => [j.company_id, j.company_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div>
      <PageHeader
        title={t("applications.title")}
        subtitle={t("applications.subtitle")}
        actions={
          <Segmented
            label={t("applications.title")}
            value={view}
            onChange={(v) => setParam("view", v === "board" ? "" : v)}
            options={[
              { value: "board", label: t("board.viewBoard") },
              { value: "list", label: t("board.viewList") },
            ]}
          />
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <NativeSelect className="w-48" aria-label={t("applications.filterCompany")} value={company} onChange={(e) => setParam("company", e.target.value)}>
          <option value="">
            {t("applications.filterCompany")}: {t("applications.filterAll")}
          </option>
          {companies.map(([id, name]) => (
            <option key={id} value={id}>
              {displayCompany(name, t)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect className="w-48" aria-label={t("applications.filterWorkMode")} value={workMode} onChange={(e) => setParam("work_mode", e.target.value)}>
          <option value="">
            {t("applications.filterWorkMode")}: {t("applications.filterAll")}
          </option>
          {["remote", "hybrid", "onsite", "unspecified"].map((m) => (
            <option key={m} value={m}>
              {t(`workMode.${m}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {board.isError ? (
        <ErrorState message={t("common.loadingFailed")} onRetry={() => board.refetch()} retryLabel={t("actions.retry")} />
      ) : board.isLoading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-96 w-72 shrink-0" />
          ))}
        </div>
      ) : view === "board" ? (
        <Board items={items} />
      ) : (
        <ApplicationList />
      )}
    </div>
  );
}

function Board({ items }: { items: JobListItem[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errMsg = useErrorMessage();
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }), useSensor(KeyboardSensor));

  const move = useMutation({
    mutationFn: (v: { id: string; status: PipelineStatus }) => api.post(`/api/jobs/${v.id}/status`, { status: v.status }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["board"] });
      const prev = qc.getQueryData<{ items: JobListItem[] }>(["board"]);
      qc.setQueryData<{ items: JobListItem[] }>(["board"], (old) => old && { items: old.items.map((j) => (j.id === v.id ? { ...j, status: v.status, last_activity_at: Date.now() } : j)) });
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["board"], ctx.prev);
      toast.error(`${t("board.moveFailed")} ${errMsg(err)}`);
    },
    onSuccess: (_r, v) => toast.success(t("board.moved", { status: t(`status.${v.status}`) })),
    onSettled: () => JOB_QUERY_ROOTS.forEach((k) => void qc.invalidateQueries({ queryKey: [k] })),
  });

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const job = items.find((j) => j.id === e.active.id);
    const col = e.over?.id as BoardColumnId | undefined;
    if (!job || !col || columnOf(job.status) === col) return;
    const target = BOARD_DROP_STATUS[col];
    if (job.application_id && (SAVED_STAGES as readonly string[]).includes(target)) {
      toast.error(t("errors.application_exists"));
      return;
    }
    move.mutate({ id: job.id, status: target });
  };
  const active = items.find((j) => j.id === activeId);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        screenReaderInstructions: { draggable: t("board.keyboardHelp") },
        announcements: {
          onDragStart: ({ active: a }) => `${items.find((j) => j.id === a.id)?.title ?? ""}`,
          onDragOver: ({ over }) => (over ? t("board.dropHint", { column: t(`board.${over.id}`) }) : ""),
          onDragEnd: ({ over }) => (over ? t("board.moved", { status: t(`board.${over.id}`) }) : ""),
          onDragCancel: () => t("actions.cancel"),
        },
      }}
    >
      <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-4 scrollbar-thin lg:-mx-6 lg:px-6">
        {BOARD_COLUMNS.map((col) => {
          const cards = items.filter((j) => (col.statuses as readonly string[]).includes(j.status));
          return <Column key={col.id} id={col.id} cards={cards} />;
        })}
      </div>
      <DragOverlay>{active ? <JobCard job={active} dragging linkable={false} /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({ id, cards }: { id: BoardColumnId; cards: JobListItem[] }) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section aria-label={t(`board.${id}`)} className="flex w-[17.5rem] shrink-0 snap-start flex-col">
      <header className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3">{t(`board.${id}`)}</h2>
        <span className="rounded bg-subtle px-1.5 text-[11px] font-medium tabular text-ink-3">{cards.length}</span>
      </header>
      <div ref={setNodeRef} className={cn("flex min-h-40 flex-1 flex-col gap-2 rounded-lg border border-dashed border-transparent bg-subtle/50 p-1.5 transition-colors", isOver && "border-accent/40 bg-accent-soft/50")}>
        {cards.map((j) => (
          <DraggableCard key={j.id} job={j} columnHasMany={id === "applied" || id === "offer" || id === "closed"} />
        ))}
        {cards.length === 0 ? <p className="py-6 text-center text-xs text-ink-4">{t("board.empty")}</p> : null}
      </div>
    </section>
  );
}

function DraggableCard({ job, columnHasMany }: { job: JobListItem; columnHasMany: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: job.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={cn("touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg", isDragging && "opacity-40")}>
      <JobCard job={job} showStatus={columnHasMany ? <StatusBadge status={job.status} /> : undefined} />
    </div>
  );
}

function ApplicationList() {
  const { t, lang, tz } = useLocaleContext();
  const query = { scope: "applications", sort: "last_activity_at", dir: "desc", page_size: 200 };
  const q = useQuery({ queryKey: ["jobs", "applications", query], queryFn: () => api.get<Paginated<JobListItem>>(`/api/jobs${qs(query)}`) });
  if (q.isLoading) return <Skeleton className="h-64" />;
  const items = q.data?.items ?? [];
  if (!items.length) return <Card><EmptyState icon={<Send />} title={t("applications.empty")} body={t("applications.emptyBody")} /></Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-[13px]">
        <thead className="border-b border-line text-left text-xs text-ink-3">
          <tr>
            <th className="px-3 py-2 font-medium">{t("positions.columns.title")}</th>
            <th className="px-3 py-2 font-medium">{t("positions.columns.status")}</th>
            <th className="px-3 py-2 font-medium">{t("positions.columns.location")}</th>
            <th className="px-3 py-2 font-medium">{t("positions.columns.salary")}</th>
            <th className="px-3 py-2 font-medium">{t("positions.columns.applied_at")}</th>
            <th className="px-3 py-2 font-medium">{t("positions.columns.last_activity_at")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((j) => (
            <tr key={j.id} className="hover:bg-subtle/50">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <CompanyAvatar name={j.company_name} size="sm" />
                  <div className="min-w-0">
                    <Link to={`/jobs/${j.id}`} className="block truncate font-medium hover:underline">
                      {displayTitle(localizedTitle(j, lang), t)}
                    </Link>
                    <span className="flex items-center gap-1.5 text-xs text-ink-3">
                      {displayCompany(j.company_name, t)} <PriorityBadge priority={j.priority} compact />
                    </span>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2">
                <StatusControl jobId={j.id} status={j.status} hasApplication size="sm" />
              </td>
              <td className="px-3 py-2 text-ink-2">
                <span className="mr-1.5">{locationText(j)}</span>
                <WorkModeBadge mode={j.work_mode} />
              </td>
              <td className="px-3 py-2 text-ink-2">
                <SalaryText salary={j.salary} />
              </td>
              <td className="px-3 py-2 text-ink-2 tabular">{formatShortDate(j.applied_at, lang, tz)}</td>
              <td className="px-3 py-2 text-ink-3">{formatRelative(j.last_activity_at, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
