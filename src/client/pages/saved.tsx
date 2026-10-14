import type { JobListItem, Paginated } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Bookmark, MoreHorizontal, Send } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { StatusBadge } from "@/components/jobs/badges";
import { JobCard } from "@/components/jobs/job-card";
import { StatusDialog } from "@/components/jobs/status-control";
import { useQuickAdd } from "@/components/layout/quick-add-context";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/tabs";
import { useStatusMutation } from "@/hooks/useJobMutations";
import { api, qs } from "@/lib/api";
import { PageHeader } from "./system";
import type { PipelineStatus } from "@shared/constants";

type Filter = "all" | "saved" | "preparing" | "starred" | "deadlineSoon";

export default function SavedJobsPage() {
  const { t } = useTranslation();
  const quickAdd = useQuickAdd();
  const [params, setParams] = useSearchParams();
  const filter = (params.get("f") as Filter) || "all";
  const sort = params.get("sort") || "saved_at";
  const [applyTarget, setApplyTarget] = React.useState<string | null>(null);
  const status = useStatusMutation();
  const query = {
    scope: "pre_application",
    status: filter === "saved" ? "saved" : filter === "preparing" ? "preparing" : "saved,preparing",
    starred: filter === "starred" ? "true" : undefined,
    sort: filter === "deadlineSoon" ? "deadline_at" : sort,
    dir: filter === "deadlineSoon" || sort === "deadline_at" || sort === "company" ? "asc" : "desc",
    page_size: 200,
  };
  const q = useQuery({ queryKey: ["jobs", "saved", query], queryFn: () => api.get<Paginated<JobListItem>>(`/api/jobs${qs(query)}`) });
  const items = (q.data?.items ?? []).filter((j) => filter !== "deadlineSoon" || (j.deadline_at && j.deadline_at > Date.now()));
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader title={t("saved.title")} subtitle={t("saved.subtitle")} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label={t("actions.filter")}
          value={filter}
          onChange={(v) => set("f", v)}
          options={(["all", "saved", "preparing", "starred", "deadlineSoon"] as Filter[]).map((f) => ({ value: f, label: t(`saved.filters.${f}`) }))}
        />
        <label className="flex items-center gap-2 text-xs text-ink-3">
          {t("saved.sortBy")}
          <NativeSelect className="w-40" value={sort} onChange={(e) => set("sort", e.target.value)}>
            <option value="saved_at">{t("positions.columns.saved_at")}</option>
            <option value="deadline_at">{t("positions.columns.deadline_at")}</option>
            <option value="priority">{t("positions.columns.priority")}</option>
            <option value="company">{t("positions.columns.company")}</option>
            <option value="salary">{t("positions.columns.salary")}</option>
          </NativeSelect>
        </label>
      </div>
      {q.isError ? (
        <ErrorState message={t("common.loadingFailed")} onRetry={() => q.refetch()} retryLabel={t("actions.retry")} />
      ) : q.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon={<Bookmark />} title={t("saved.empty")} body={t("saved.emptyBody")} action={<Button variant="primary" onClick={() => quickAdd.open()}>{t("actions.addJob")}</Button>} />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((j) => (
            <JobCard
              key={j.id}
              job={j}
              showStatus={<StatusBadge status={j.status} />}
              actions={
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={t("actions.changeStatus")}>
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => setApplyTarget(j.id)}>
                      <Send />
                      {t("actions.markApplied")}
                    </MenuItem>
                    {j.status !== "preparing" ? <MenuItem onSelect={() => status.mutate({ id: j.id, status: "preparing" })}>{t("status.preparing")}</MenuItem> : null}
                    {j.status !== "saved" ? <MenuItem onSelect={() => status.mutate({ id: j.id, status: "saved" })}>{t("status.saved")}</MenuItem> : null}
                    <MenuItem onSelect={() => status.mutate({ id: j.id, status: "closed" as PipelineStatus })}>{t("status.closed")}</MenuItem>
                    <MenuItem onSelect={() => status.mutate({ id: j.id, status: "archived" })}>{t("actions.archive")}</MenuItem>
                  </MenuContent>
                </Menu>
              }
            />
          ))}
        </div>
      )}
      <StatusDialog jobId={applyTarget ?? ""} target={applyTarget ? "applied" : null} onClose={() => setApplyTarget(null)} />
    </div>
  );
}
