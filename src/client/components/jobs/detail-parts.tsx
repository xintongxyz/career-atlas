import type { ExtractableField } from "@shared/constants";
import type { DocumentDTO, EvidenceDTO, JobDetail, OverrideDTO } from "@shared/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { NativeSelect } from "@/components/ui/input";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs } from "@/hooks/useJobMutations";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EvidencePopover } from "./evidence";

export type DetailCtx = { job: JobDetail; evidence: Map<string, EvidenceDTO>; overrides: Map<string, OverrideDTO>; confirm: (f: string) => void };

export function useDetailCtx(job: JobDetail): DetailCtx {
  const invalidate = useInvalidateJobs();
  const { t } = useTranslation();
  const onError = useToastError();
  const confirm = useMutation({
    mutationFn: (field: string) => api.post(`/api/jobs/${job.id}/fields/review`, { field, action: "confirm" }),
    onSuccess: () => {
      toast.success(t("extraction.fieldConfirmed"));
      void invalidate();
    },
    onError,
  });
  return React.useMemo(
    () => ({ job, evidence: new Map(job.evidence.map((e) => [e.field, e])), overrides: new Map(job.overrides.map((o) => [o.field, o])), confirm: (f: string) => confirm.mutate(f) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job],
  );
}

/** Label/value row with provenance popover. Unknown values stay visibly unknown. */
export function FieldRow({ ctx, field, label, children, emphasis, empty }: { ctx: DetailCtx; field?: ExtractableField; label: React.ReactNode; children?: React.ReactNode; emphasis?: boolean; empty?: boolean }) {
  const { t } = useTranslation();
  const ev = field ? ctx.evidence.get(field) : undefined;
  const ov = field ? ctx.overrides.get(field) : undefined;
  const isEmpty = empty ?? (children == null || children === "" || children === false);
  return (
    <div className={cn("grid grid-cols-[minmax(6.5rem,34%)_1fr] gap-3 py-1.5 text-[13px]", emphasis && "rounded-md bg-warn-soft/50 px-2 -mx-2")}>
      <dt className="text-ink-3">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1 break-words text-ink">{isEmpty ? <span className="text-ink-4">{t("common.notSpecified")}</span> : children}</div>
        {field ? <EvidencePopover evidence={ev} override={ov} onConfirm={() => ctx.confirm(field)} /> : null}
      </dd>
    </div>
  );
}

export function ListBlock({ ctx, field, title, items }: { ctx: DetailCtx; field: ExtractableField; title: string; items: string[] | null | undefined }) {
  if (!items?.length) return null;
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1">
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        <EvidencePopover evidence={ctx.evidence.get(field)} override={ctx.overrides.get(field)} onConfirm={() => ctx.confirm(field)} />
      </div>
      <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-ink-2 marker:text-ink-4">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </section>
  );
}

export function ChipList({ items }: { items: string[] | null | undefined }) {
  if (!items?.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((s) => (
        <span key={s} className="rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-ink-2">
          {s}
        </span>
      ))}
    </div>
  );
}

export function useDocuments() {
  return useQuery({ queryKey: ["documents"], queryFn: () => api.get<{ items: DocumentDTO[] }>("/api/documents"), staleTime: 60_000 });
}

export function DocumentSelect({ value, onChange, kind, id, label }: { value: string | null; onChange: (v: string | null) => void; kind: "resume" | "cover_letter"; id: string; label: string }) {
  const { t } = useTranslation();
  const docs = useDocuments();
  const options = (docs.data?.items ?? []).filter((d) => d.kind === kind || d.id === value);
  return (
    <NativeSelect id={id} aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t("documents.none")}</option>
      {options.map((d) => (
        <option key={d.id} value={d.id}>
          {d.version_name}
        </option>
      ))}
    </NativeSelect>
  );
}
