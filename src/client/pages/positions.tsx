import { EMPLOYMENT_TYPES, PIPELINE_STATUSES, PRIORITIES, SALARY_PERIODS, SOURCE_PLATFORMS, WORK_MODES } from "@shared/constants";
import type { JobListItem } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState, type VisibilityState } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Bookmark, Columns3, Download, Filter, GitCompare, Search, Tag, Trash2, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { MatchLevelBadge } from "@/components/jobs/match-panel";
import { localizedTitle } from "@/lib/job-i18n";
import { CompanyAvatar, ExtractionBadge, PriorityBadge, SalaryText, StarMark, StatusBadge, displayCompany, displayTitle } from "@/components/jobs/badges";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Badge, Card, Checkbox, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlay";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs } from "@/hooks/useJobMutations";
import { useLocaleContext } from "@/hooks/useMe";
import { api, qs } from "@/lib/api";
import { formatShortDate, fromDateInput, locationText, toDateInput } from "@/lib/format";
import { cn, downloadBlob } from "@/lib/utils";
import { PageHeader } from "./system";

type ListResponse = { items: JobListItem[]; total: number; page: number; page_size: number; salary_filter: { excluded_unknown: number; excluded_not_comparable: number } | null };

const FILTER_KEYS = ["q", "status", "work_mode", "employment_type", "priority", "source", "tag", "company_id", "location", "skill", "restriction", "needs_review", "starred", "archived", "scope", "salary_min", "salary_currency", "salary_period", "saved_from", "saved_to", "applied_from", "applied_to"] as const;
const COLS_KEY = "career-atlas.positions.columns";
const DEFAULT_HIDDEN: VisibilityState = { employment_type: false, source: false, applied_at: false, last_activity_at: false, tags: false };

function loadColumns(): VisibilityState {
  try {
    return { ...DEFAULT_HIDDEN, ...JSON.parse(localStorage.getItem(COLS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_HIDDEN;
  }
}

export default function PositionsPage() {
  const { t, lang, tz } = useLocaleContext();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invalidate = useInvalidateJobs();
  const onError = useToastError();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = React.useState(params.get("q") ?? "");
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(loadColumns);

  React.useEffect(() => {
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(columnVisibility));
    } catch {
      /* ignore */
    }
  }, [columnVisibility]);

  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined]).filter(([, v]) => v)) as Record<string, string>;
  const sort = params.get("sort") ?? "saved_at";
  const dir = (params.get("dir") as "asc" | "desc") ?? "desc";
  const page = Number(params.get("page") ?? 1);
  const query = { ...filters, sort, dir, page, page_size: 50 };

  const setParam = React.useCallback(
    (patch: Record<string, string | undefined>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          if (!("page" in patch)) next.delete("page");
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  React.useEffect(() => {
    const h = setTimeout(() => {
      if ((params.get("q") ?? "") !== search) setParam({ q: search || undefined });
    }, 250);
    return () => clearTimeout(h);
  }, [search, params, setParam]);

  const list = useQuery({ queryKey: ["jobs", "positions", query], queryFn: () => api.get<ListResponse>(`/api/jobs${qs(query)}`), placeholderData: (prev) => prev });
  const items = list.data?.items ?? [];
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);

  const bulk = useMutation({
    mutationFn: (action: Record<string, unknown>) => api.post<{ affected: number }>("/api/jobs/bulk", { ids: selectedIds, action }),
    onSuccess: (r) => {
      toast.success(t("positions.bulk.done", { count: r.affected }));
      setRowSelection({});
      void invalidate();
      void qc.invalidateQueries({ queryKey: ["tags"] });
    },
    onError,
  });

  const sortHeader = (key: string, label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 hover:text-ink"
      onClick={() => setParam({ sort: key, dir: sort === key && dir === "desc" ? "asc" : "desc" })}
      aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      {sort === key ? dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
    </button>
  );

  const columns = React.useMemo<ColumnDef<JobListItem>[]>(
    () => [
      {
        id: "select",
        enableHiding: false,
        header: ({ table }) => (
          <Checkbox
            aria-label={t("actions.selectAll")}
            checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
          />
        ),
        cell: ({ row }) => <Checkbox aria-label={t("actions.select")} checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} />,
      },
      {
        id: "title",
        enableHiding: false,
        header: () => sortHeader("company", `${t("positions.columns.company")} / ${t("positions.columns.title")}`),
        cell: ({ row: { original: j } }) => (
          <div className="flex min-w-56 items-center gap-2.5">
            <CompanyAvatar name={j.company_name} size="sm" />
            <div className="min-w-0">
              <Link to={`/jobs/${j.id}`} className="flex items-center gap-1 font-medium text-ink hover:underline">
                <span className="truncate">{displayTitle(localizedTitle(j, lang), t)}</span>
                <StarMark starred={j.is_starred} />
              </Link>
              <div className="flex items-center gap-1.5 text-xs text-ink-3">
                <span className="truncate">{displayCompany(j.company_name, t)}</span>
                <ExtractionBadge status={j.extraction_status} />
                {j.pending_extraction ? <Badge tone="accent">{t("extraction.banner.readyShort")}</Badge> : j.needs_review_count ? <Badge tone="warn">{t("extraction.pendingReview", { count: j.needs_review_count })}</Badge> : null}
              </div>
            </div>
          </div>
        ),
      },
      { id: "status", header: () => t("positions.columns.status"), cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      {
        id: "match",
        header: () => t("positions.columns.match"),
        cell: ({ row }) => {
          const m = row.original.match;
          if (!m) return <span className="text-xs text-ink-4">—</span>;
          return (
            <span className="flex flex-col items-start gap-0.5 whitespace-nowrap">
              <MatchLevelBadge level={m.level} score={null} />
              <span className="text-[11px] text-ink-4">{t("match.mustHavesShort", { met: m.mandatory.met, total: m.mandatory.total })}</span>
            </span>
          );
        },
      },
      {
        id: "location",
        header: () => t("positions.columns.location"),
        cell: ({ row: { original: j } }) => (
          <div className="min-w-32">
            <div className="truncate text-ink-2">{locationText(j) || <span className="text-ink-4">—</span>}</div>
            {j.work_mode !== "unspecified" ? <div className="text-xs text-ink-3">{t(`workMode.${j.work_mode}`)}</div> : null}
          </div>
        ),
      },
      { id: "employment_type", header: () => t("positions.columns.employment_type"), cell: ({ row }) => <span className="text-ink-2">{t(`employmentType.${row.original.employment_type}`)}</span> },
      { id: "salary", header: () => sortHeader("salary", t("positions.columns.salary")), cell: ({ row }) => <SalaryText salary={row.original.salary} showSource className="whitespace-nowrap text-ink-2" /> },
      { id: "priority", header: () => sortHeader("priority", t("positions.columns.priority")), cell: ({ row }) => <PriorityBadge priority={row.original.priority} /> },
      { id: "source", header: () => t("positions.columns.source"), cell: ({ row }) => <span className="text-ink-3">{t(`platform.${row.original.source_platform}`)}</span> },
      {
        id: "tags",
        header: () => t("positions.columns.tags"),
        cell: ({ row }) => (
          <div className="flex max-w-48 flex-wrap gap-1">
            {row.original.tags.map((tg) => (
              <Badge key={tg.id}>{tg.name}</Badge>
            ))}
          </div>
        ),
      },
      { id: "deadline_at", header: () => sortHeader("deadline_at", t("positions.columns.deadline_at")), cell: ({ row }) => <span className="whitespace-nowrap tabular text-ink-2">{formatShortDate(row.original.deadline_at, lang, tz)}</span> },
      { id: "saved_at", header: () => sortHeader("saved_at", t("positions.columns.saved_at")), cell: ({ row }) => <span className="whitespace-nowrap tabular text-ink-3">{formatShortDate(row.original.saved_at, lang, tz)}</span> },
      { id: "applied_at", header: () => sortHeader("applied_at", t("positions.columns.applied_at")), cell: ({ row }) => <span className="whitespace-nowrap tabular text-ink-3">{formatShortDate(row.original.applied_at, lang, tz)}</span> },
      { id: "last_activity_at", header: () => sortHeader("last_activity_at", t("positions.columns.last_activity_at")), cell: ({ row }) => <span className="whitespace-nowrap tabular text-ink-3">{formatShortDate(row.original.last_activity_at, lang, tz)}</span> },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, lang, tz, sort, dir],
  );

  const table = useReactTable({
    data: items,
    columns,
    getRowId: (r) => r.id,
    state: { rowSelection, columnVisibility },
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
  });

  const exportCsv = async () => {
    try {
      const headers = Object.fromEntries(Object.keys(t("export.columns", { returnObjects: true }) as Record<string, string>).map((k) => [k, t(`export.columns.${k}`)]));
      const status_labels = Object.fromEntries(PIPELINE_STATUSES.map((s) => [s, t(`status.${s}`)]));
      const blob = await api.download("/api/export/csv", { method: "POST", body: { headers, status_labels } });
      downloadBlob(blob, `career-atlas-jobs-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      onError(e);
    }
  };

  const activeCount = Object.keys(filters).filter((k) => k !== "q").length;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <div>
      <PageHeader
        title={t("positions.title")}
        subtitle={t("positions.subtitle")}
        actions={
          <>
            <SavedViews params={params} columns={columnVisibility} onLoad={(state) => {
              setParams(new URLSearchParams((state.params as string) ?? ""), { replace: true });
              setSearch(new URLSearchParams((state.params as string) ?? "").get("q") ?? "");
              if (state.columns) setColumnVisibility(state.columns as VisibilityState);
            }} />
            <Button onClick={exportCsv}>
              <Download />
              {t("positions.exportCsv")}
            </Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-4" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("positions.searchPlaceholder")} className="pl-8" aria-label={t("actions.search")} />
        </div>
        <FilterPopover filters={filters} setParam={setParam} activeCount={activeCount} />
        <QuickSelect label={t("positions.filter.status")} value={filters.status} options={PIPELINE_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))} onChange={(v) => setParam({ status: v })} />
        <QuickSelect label={t("positions.filter.workMode")} value={filters.work_mode} options={WORK_MODES.map((s) => ({ value: s, label: t(`workMode.${s}`) }))} onChange={(v) => setParam({ work_mode: v })} />
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost">
              <Columns3 />
              {t("actions.columns")}
            </Button>
          </MenuTrigger>
          <MenuContent>
            {table
              .getAllLeafColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <MenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(!!v)} onSelect={(e) => e.preventDefault()}>
                  {t(`positions.columns.${c.id}`)}
                </MenuCheckboxItem>
              ))}
          </MenuContent>
        </Menu>
        {activeCount || filters.q ? (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch("");
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            <X />
            {t("actions.clearAll")}
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-ink-3">{t("common.results", { count: total })}</span>
      </div>
      <ActiveFilterChips filters={filters} setParam={setParam} />
      {list.data?.salary_filter ? (
        <p className="mb-2 rounded-md bg-info-soft px-3 py-1.5 text-xs text-info">
          {t("salary.filterNote", { unknown: list.data.salary_filter.excluded_unknown, mismatch: list.data.salary_filter.excluded_not_comparable })}
        </p>
      ) : null}
      {filters.restriction === "none_known" ? <p className="mb-2 text-xs text-ink-3">{t("positions.restrictionNote")}</p> : null}

      {selectedIds.length ? (
        <div className="sticky top-16 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-[13px]">
          <span className="font-medium text-accent">{t("common.selected", { count: selectedIds.length })}</span>
          <BulkTag label={t("positions.bulk.addTag")} onSubmit={(tag) => bulk.mutate({ type: "add_tag", tag })} />
          <BulkTag label={t("positions.bulk.removeTag")} onSubmit={(tag) => bulk.mutate({ type: "remove_tag", tag })} />
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm">{t("positions.bulk.setPriority")}</Button>
            </MenuTrigger>
            <MenuContent align="start">
              {[...PRIORITIES, null].map((p) => (
                <MenuItem key={p ?? "none"} onSelect={() => bulk.mutate({ type: "set_priority", priority: p })}>
                  {p ? t(`priority.${p}`) : t("priority.none")}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          {filters.archived === "only" ? (
            <Button size="sm" onClick={() => bulk.mutate({ type: "restore" })}>
              {t("positions.bulk.restore")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => bulk.mutate({ type: "archive" })}>
              {t("positions.bulk.archive")}
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={selectedIds.length < 2 || selectedIds.length > 4} onClick={() => navigate(`/compare?ids=${selectedIds.join(",")}`)}>
            <GitCompare />
            {t("positions.bulk.compare")}
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRowSelection({})}>
            {t("actions.clear")}
          </Button>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {list.isError ? (
          <ErrorState message={t("common.loadingFailed")} onRetry={() => list.refetch()} retryLabel={t("actions.retry")} />
        ) : list.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Filter />} title={t("positions.empty")} body={t("positions.emptyBody")} />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-[13px]">
              <thead className="border-b border-line bg-subtle/40 text-left text-xs text-ink-3">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <th key={h.id} className={cn("whitespace-nowrap px-3 py-2 font-medium", h.id === "select" && "w-8")}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className={cn("divide-y divide-line", list.isFetching && "opacity-70")}>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className={cn("hover:bg-subtle/40", row.getIsSelected() && "bg-accent-soft/40")}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 ? (
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-3">
            <span>{t("common.page", { page, pages })}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}>
                {t("common.previous")}
              </Button>
              <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setParam({ page: String(page + 1) })}>
                {t("common.next")}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function QuickSelect({ label, value, options, onChange }: { label: string; value?: string; options: { value: string; label: string }[]; onChange: (v?: string) => void }) {
  const { t } = useTranslation();
  const selected = new Set(value?.split(",") ?? []);
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant={selected.size ? "subtle" : "ghost"}>
          {label}
          {selected.size ? <span className="rounded bg-accent px-1 text-[10px] text-accent-ink">{selected.size}</span> : null}
        </Button>
      </MenuTrigger>
      <MenuContent align="start">
        {options.map((o) => (
          <MenuCheckboxItem
            key={o.value}
            checked={selected.has(o.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(c) => {
              const next = new Set(selected);
              if (c) next.add(o.value);
              else next.delete(o.value);
              onChange(next.size ? [...next].join(",") : undefined);
            }}
          >
            {o.label}
          </MenuCheckboxItem>
        ))}
        {selected.size ? (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => onChange(undefined)}>{t("actions.clear")}</MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

function ActiveFilterChips({ filters, setParam }: { filters: Record<string, string>; setParam: (p: Record<string, string | undefined>) => void }) {
  const { t, lang, tz } = useLocaleContext();
  const chips = Object.entries(filters).filter(([k]) => k !== "q" && k !== "salary_currency" && k !== "salary_period");
  if (!chips.length) return null;
  const label = (k: string, v: string) => {
    const multi = (ns: string) => v.split(",").map((x) => t(`${ns}.${x}`)).join(", ");
    switch (k) {
      case "status":
        return multi("status");
      case "work_mode":
        return multi("workMode");
      case "employment_type":
        return multi("employmentType");
      case "priority":
        return multi("priority");
      case "source":
        return multi("platform");
      case "restriction":
        return t(`positions.restriction.${v}`);
      case "archived":
        return t(`positions.archived.${v}`);
      case "scope":
        return t(`positions.scope.${v}`);
      case "needs_review":
        return t("positions.filter.needsReview");
      case "starred":
        return t("positions.filter.starred");
      case "salary_min":
        return `${t("positions.filter.salaryMin")} ${Number(v).toLocaleString(lang)} ${filters.salary_currency ?? "CAD"} ${t(`salary.per.${filters.salary_period ?? "annually"}`)}`;
      case "saved_from":
      case "saved_to":
      case "applied_from":
      case "applied_to":
        return `${t(`positions.filter.${k.startsWith("saved") ? "savedRange" : "appliedRange"}`)} ${k.endsWith("from") ? "≥" : "≤"} ${formatShortDate(Number(v), lang, tz)}`;
      case "company_id":
        return t("fields.company_name");
      default:
        return `${t(`positions.filter.${k}`, { defaultValue: k })}: ${v}`;
    }
  };
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {chips.map(([k, v]) => (
        <span key={k} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-2.5 pr-1 text-xs text-ink-2">
          {label(k, v)}
          <button type="button" aria-label={t("actions.clear")} className="rounded-full p-0.5 text-ink-4 hover:bg-subtle hover:text-ink" onClick={() => setParam(k === "salary_min" ? { salary_min: undefined, salary_currency: undefined, salary_period: undefined } : { [k]: undefined })}>
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

function FilterPopover({ filters, setParam, activeCount }: { filters: Record<string, string>; setParam: (p: Record<string, string | undefined>) => void; activeCount: number }) {
  const { t, tz } = useLocaleContext();
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api.get<{ items: { id: string; name: string }[] }>("/api/tags") });
  const multi = (key: string, values: readonly string[], ns: string) => {
    const sel = new Set(filters[key]?.split(",") ?? []);
    return (
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={sel.has(v)}
            onClick={() => {
              const next = new Set(sel);
              if (next.has(v)) next.delete(v);
              else next.add(v);
              setParam({ [key]: next.size ? [...next].join(",") : undefined });
            }}
            className={cn("rounded border px-1.5 py-0.5 text-xs", sel.has(v) ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2 hover:bg-subtle")}
          >
            {t(`${ns}.${v}`)}
          </button>
        ))}
      </div>
    );
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={activeCount ? "subtle" : "secondary"}>
          <Filter />
          {activeCount ? t("positions.activeFilters", { count: activeCount }) : t("positions.filters")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-[75vh] w-[min(36rem,calc(100vw-24px))] overflow-y-auto" align="start">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("positions.filter.scope")} className="sm:col-span-2">
            <NativeSelect value={filters.scope ?? "all"} onChange={(e) => setParam({ scope: e.target.value === "all" ? undefined : e.target.value })}>
              {(["all", "pre_application", "applications"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`positions.scope.${s}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("positions.filter.employmentType")} className="sm:col-span-2">
            {multi("employment_type", EMPLOYMENT_TYPES, "employmentType")}
          </Field>
          <Field label={t("positions.filter.priority")}>{multi("priority", [...PRIORITIES, "none"], "priority")}</Field>
          <Field label={t("positions.filter.source")}>{multi("source", SOURCE_PLATFORMS, "platform")}</Field>
          {tags.data?.items.length ? (
            <Field label={t("positions.filter.tags")} className="sm:col-span-2">
              <div className="flex flex-wrap gap-1">
                {tags.data.items.map((tg) => {
                  const sel = new Set(filters.tag?.split(",") ?? []);
                  const key = tg.name.toLowerCase();
                  return (
                    <button
                      key={tg.id}
                      type="button"
                      aria-pressed={sel.has(key)}
                      onClick={() => {
                        if (sel.has(key)) sel.delete(key);
                        else sel.add(key);
                        setParam({ tag: sel.size ? [...sel].join(",") : undefined });
                      }}
                      className={cn("rounded border px-1.5 py-0.5 text-xs", sel.has(key) ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2 hover:bg-subtle")}
                    >
                      {tg.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          ) : null}
          <Field label={t("positions.filter.location")} htmlFor="f-loc">
            <Input id="f-loc" defaultValue={filters.location} onBlur={(e) => setParam({ location: e.target.value.trim() || undefined })} onKeyDown={(e) => e.key === "Enter" && setParam({ location: e.currentTarget.value.trim() || undefined })} />
          </Field>
          <Field label={t("positions.filter.skill")} htmlFor="f-skill">
            <Input id="f-skill" defaultValue={filters.skill} placeholder="SQL" onBlur={(e) => setParam({ skill: e.target.value.trim() || undefined })} onKeyDown={(e) => e.key === "Enter" && setParam({ skill: e.currentTarget.value.trim() || undefined })} />
          </Field>
          <Field label={t("positions.filter.restriction")} className="sm:col-span-2" hint={t("positions.restrictionNote")}>
            <NativeSelect value={filters.restriction ?? ""} onChange={(e) => setParam({ restriction: e.target.value || undefined })}>
              <option value="">{t("common.all")}</option>
              {(["any", "work_authorization", "visa_not_available", "citizenship", "security_clearance", "none_known"] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`positions.restriction.${r}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("positions.filter.salaryMin")} className="sm:col-span-2" hint={t("salary.notComparable")}>
            <div className="grid grid-cols-3 gap-2">
              <Input type="number" min={0} defaultValue={filters.salary_min} placeholder="70000" onBlur={(e) => setParam({ salary_min: e.target.value || undefined, salary_currency: e.target.value ? (filters.salary_currency ?? "CAD") : undefined, salary_period: e.target.value ? (filters.salary_period ?? "annually") : undefined })} />
              <Input maxLength={3} defaultValue={filters.salary_currency ?? "CAD"} onBlur={(e) => filters.salary_min && setParam({ salary_currency: e.target.value.toUpperCase() || "CAD" })} aria-label={t("salary.currency")} />
              <NativeSelect value={filters.salary_period ?? "annually"} onChange={(e) => filters.salary_min && setParam({ salary_period: e.target.value })} aria-label={t("salary.period.annually")}>
                {SALARY_PERIODS.filter((p) => p !== "unknown" && p !== "other").map((p) => (
                  <option key={p} value={p}>
                    {t(`salary.period.${p}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </Field>
          {(["saved", "applied"] as const).map((kind) => (
            <Field key={kind} label={t(`positions.filter.${kind}Range`)}>
              <div className="grid grid-cols-2 gap-1">
                <Input type="date" aria-label={t("common.from")} value={toDateInput(filters[`${kind}_from`] ? Number(filters[`${kind}_from`]) : null, tz)} onChange={(e) => setParam({ [`${kind}_from`]: e.target.value ? String(fromDateInput(e.target.value, tz, "00:00")) : undefined })} />
                <Input type="date" aria-label={t("common.to")} value={toDateInput(filters[`${kind}_to`] ? Number(filters[`${kind}_to`]) : null, tz)} onChange={(e) => setParam({ [`${kind}_to`]: e.target.value ? String(fromDateInput(e.target.value, tz, "23:59")) : undefined })} />
              </div>
            </Field>
          ))}
          <Field label={t("positions.filter.archived")}>
            <NativeSelect value={filters.archived ?? "exclude"} onChange={(e) => setParam({ archived: e.target.value === "exclude" ? undefined : e.target.value })}>
              {(["exclude", "include", "only"] as const).map((a) => (
                <option key={a} value={a}>
                  {t(`positions.archived.${a}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex flex-col justify-end gap-2 text-[13px] text-ink-2">
            <label className="flex items-center gap-2">
              <Checkbox checked={filters.needs_review === "true"} onCheckedChange={(v) => setParam({ needs_review: v ? "true" : undefined })} />
              {t("positions.filter.needsReview")}
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={filters.starred === "true"} onCheckedChange={(v) => setParam({ starred: v ? "true" : undefined })} />
              {t("positions.filter.starred")}
            </label>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BulkTag({ label, onSubmit }: { label: string; onSubmit: (tag: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = React.useState("");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm">
          <Tag />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onSubmit(value.trim());
            setValue("");
          }}
        >
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("positions.bulk.tagPlaceholder")} maxLength={40} />
          <Button type="submit" size="md" variant="primary">
            {t("actions.apply")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function SavedViews({ params, columns, onLoad }: { params: URLSearchParams; columns: VisibilityState; onLoad: (state: Record<string, unknown>) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onError = useToastError();
  const views = useQuery({ queryKey: ["views"], queryFn: () => api.get<{ items: { id: string; name: string; state: Record<string, unknown> }[] }>("/api/views?page=positions") });
  const [name, setName] = React.useState("");
  const save = useMutation({
    mutationFn: () => api.post("/api/views", { name, page: "positions", state: { params: params.toString(), columns } }),
    onSuccess: () => {
      toast.success(t("positions.views.saved"));
      setName("");
      void qc.invalidateQueries({ queryKey: ["views"] });
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/views/${id}`),
    onSuccess: () => {
      toast(t("positions.views.deleted"));
      void qc.invalidateQueries({ queryKey: ["views"] });
    },
    onError,
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button>
          <Bookmark />
          {t("positions.views.title")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <MenuLabelStatic>{t("positions.views.title")}</MenuLabelStatic>
        {views.data?.items.length ? (
          <ul className="mb-2 space-y-0.5">
            {views.data.items.map((v) => (
              <li key={v.id} className="group flex items-center gap-1">
                <button type="button" className="flex-1 truncate rounded px-2 py-1 text-left hover:bg-subtle" onClick={() => onLoad(v.state)}>
                  {v.name}
                </button>
                <Button variant="ghost" size="icon-sm" aria-label={t("actions.delete")} onClick={() => del.mutate(v.id)}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-2 px-2 text-xs text-ink-4">{t("positions.views.none")}</p>
        )}
        <form
          className="flex gap-2 border-t border-line pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("positions.views.namePrompt")} maxLength={80} />
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {t("actions.save")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function MenuLabelStatic({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-ink-4">{children}</p>;
}
