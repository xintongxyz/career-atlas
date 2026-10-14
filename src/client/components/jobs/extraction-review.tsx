import { EXTRACTABLE_FIELDS, type ExtractableField } from "@shared/constants";
import type { DuplicateMatch, ExtractionDTO, ResultField } from "@shared/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, PencilLine, Sparkles } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Checkbox } from "@/components/ui/misc";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs } from "@/hooks/useJobMutations";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatValue } from "./evidence";
import { ValueDisplay, ValueEditor } from "./value-editor";

interface Row {
  field: ExtractableField;
  candidate: ResultField;
  current: unknown;
  changed: boolean;
  overridden: boolean;
}

function isEmptyValue(v: unknown) {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0) || v === "unknown" || v === "unspecified";
}
function same(a: unknown, b: unknown) {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Human-in-the-loop review: every extracted value is shown with its source,
 * confidence and verbatim evidence. Nothing is stored until the user saves.
 * In refresh mode only changed fields are preselected and manual edits are kept.
 */
export function ExtractionReview({
  extraction,
  onApplied,
  onDismiss,
  compact,
  endpoints,
  applyExtra,
}: {
  extraction: ExtractionDTO;
  onApplied?: (savedJobId: string) => void;
  onDismiss?: () => void;
  compact?: boolean;
  /** AI drafts save/discard through their own endpoints; extractions use the defaults. */
  endpoints?: { apply: string; dismiss: string };
  /** Extra body fields for the apply request (e.g. confirm_duplicate for drafts). */
  applyExtra?: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const onError = useToastError();
  const invalidate = useInvalidateJobs();
  const result = extraction.result!;
  const refresh = extraction.purpose === "refresh";
  const overridden = new Set(extraction.overridden_fields ?? []);

  // Core fields are always reviewable on a new job, even when nothing was extracted, so the user
  // can type a missing company or title instead of having to edit the job afterwards.
  const CORE: ExtractableField[] = ["company_name", "title"];
  const rows: Row[] = React.useMemo(
    () =>
      EXTRACTABLE_FIELDS.filter((f) => result.fields[f] || (!refresh && CORE.includes(f))).map((f) => {
        const current = extraction.current?.[f];
        const candidate: ResultField = result.fields[f] ?? { value: "", source: "user", evidence: null, confidence: "high", missing: true } as ResultField & { missing: true };
        return { field: f, candidate, current, changed: !same(current, candidate.value), overridden: overridden.has(f) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extraction.id],
  );
  const visibleRows = refresh ? rows.filter((r) => r.changed) : rows;

  const [values, setValues] = React.useState<Record<string, unknown>>(() => Object.fromEntries(rows.map((r) => [r.field, r.candidate.value])));
  const isMissing = (r: Row) => (r.candidate as ResultField & { missing?: boolean }).missing === true;
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(rows.filter((r) => !isMissing(r) && (refresh ? r.changed && !r.overridden : r.field !== "posting_status" || r.candidate.value === "closed")).map((r) => r.field)),
  );
  const [later, setLater] = React.useState<Set<string>>(() => new Set(rows.filter((r) => r.candidate.needs_review).map((r) => r.field)));
  const [includeDescription, setIncludeDescription] = React.useState(!!result.description_text && !refresh);
  const [editing, setEditing] = React.useState<string | null>(() => rows.find(isMissing)?.field ?? null);

  // Possible duplicate by company + title (only meaningful for new jobs).
  const company = values.company_name as string | undefined;
  const title = values.title as string | undefined;
  const dup = useQuery({
    queryKey: ["dup-after-extract", extraction.id, company, title],
    queryFn: () => api.post<{ matches: DuplicateMatch[] }>("/api/jobs/check-duplicates", { company_name: company, title, city: (values.city as string) || undefined }),
    enabled: !refresh && !!company && !!title,
    select: (d) => d.matches.filter((m) => m.id !== extraction.saved_job_id),
  });

  const apply = useMutation({
    mutationFn: () => {
      const fields: Record<string, unknown> = {};
      for (const f of selected) fields[f] = values[f];
      if (includeDescription) fields.description_text = true;
      return api.post<{ saved_job_id: string }>(endpoints?.apply ?? `/api/extractions/${extraction.id}/apply`, { fields, review_later: [...later].filter((f) => selected.has(f)), ...applyExtra });
    },
    onSuccess: (res) => {
      toast.success(t("extraction.review.applied"));
      void invalidate();
      onApplied?.(res.saved_job_id);
    },
    onError,
  });
  const dismiss = useMutation({
    mutationFn: () => api.post(endpoints?.dismiss ?? `/api/extractions/${extraction.id}/dismiss`),
    onSuccess: () => {
      toast(t("extraction.review.dismissed"));
      void invalidate();
      onDismiss?.();
    },
    onError,
  });

  const toggle = (set: Set<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-[13px] text-ink-2">{refresh ? t("extraction.review.refreshIntro") : t("extraction.review.intro")}</p>
        <Badge tone={result.ai_used ? "violet" : "neutral"}>
          <Sparkles />
          {result.ai_used ? t("extraction.review.aiUsed") : t("extraction.review.aiNotUsed")}
        </Badge>
      </div>
      {result.warnings.length ? (
        <ul className="space-y-1 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
          {result.warnings.map((w) => {
            const [code, field] = w.split(":");
            return <li key={w}>{t(`extraction.warnings.${code}`, { field: field ? t(`fields.${field}`) : "" })}</li>;
          })}
        </ul>
      ) : null}
      {dup.data?.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
          <AlertTriangle className="size-4" />
          {t("extraction.review.possibleDuplicate")}
          {dup.data.slice(0, 2).map((m) => (
            <Link key={m.id} to={`/jobs/${m.id}`} className="font-medium underline">
              {m.company_name} — {m.title}
            </Link>
          ))}
        </div>
      ) : null}

      {visibleRows.length === 0 ? (
        <p className="rounded-md bg-subtle px-3 py-6 text-center text-[13px] text-ink-3">{refresh ? t("extraction.review.noChanges") : t("extraction.review.empty")}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="flex items-center gap-3 border-b border-line bg-subtle/60 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-4">
            <Checkbox
              aria-label={t("extraction.review.selectAll")}
              checked={selected.size === visibleRows.length ? true : selected.size === 0 ? false : "indeterminate"}
              onCheckedChange={(c) => setSelected(c ? new Set(visibleRows.map((r) => r.field)) : new Set())}
            />
            <span className="flex-1">{t("extraction.review.field")}</span>
            <span className="hidden sm:block">{t("extraction.review.reviewLater")}</span>
          </div>
          <ul className="divide-y divide-line">
            {visibleRows.map((r) => {
              const c = r.candidate;
              const isEditing = editing === r.field;
              const edited = !same(values[r.field], c.value);
              return (
                <li key={r.field} className={cn("px-3 py-2.5", !selected.has(r.field) && "bg-canvas/50")}>
                  <div className="flex items-start gap-3">
                    <Checkbox className="mt-0.5" aria-label={t(`fields.${r.field}`)} checked={selected.has(r.field)} onCheckedChange={(v) => setSelected((s) => toggle(s, r.field, !!v))} />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium text-ink">{t(`fields.${r.field}`)}</span>
                        {isMissing(r) ? (
                          <Badge tone="warn">{t("extraction.review.notFound")}</Badge>
                        ) : (
                          <>
                            <Badge tone="outline">{t(`extraction.source.${edited ? "user" : c.source}`)}</Badge>
                            <Badge tone={c.confidence === "high" ? "ok" : c.confidence === "medium" ? "neutral" : "warn"}>{t(`extraction.confidence.${c.confidence}`)}</Badge>
                          </>
                        )}
                        {c.basis ? <BasisBadge basis={c.basis} sourceUrl={c.source_url ?? null} /> : null}
                        {c.conflict ? <Badge tone="warn">{t("extraction.review.conflict")}</Badge> : null}
                        {c.needs_review ? <Badge tone="warn">{t("extraction.review.needsReview")}</Badge> : null}
                        {r.overridden ? <Badge tone="info">{t("extraction.review.manualEdit")}</Badge> : null}
                        {refresh ? <Badge tone="accent">{isEmptyValue(r.current) ? t("extraction.review.new") : t("extraction.review.changed")}</Badge> : null}
                      </div>
                      {refresh && !isEmptyValue(r.current) ? (
                        <div className="text-xs text-ink-3">
                          <span className="font-medium">{t("extraction.review.current")}: </span>
                          <span className="line-through decoration-ink-4/60">{formatValue(r.current)}</span>
                        </div>
                      ) : null}
                      <div className="flex items-start gap-2 text-[13px] text-ink-2">
                        <div className="min-w-0 flex-1">{isEditing ? <ValueEditor
                              id={`rv-${r.field}`}
                              field={r.field}
                              value={values[r.field]}
                              onChange={(v) => {
                                setValues((s) => ({ ...s, [r.field]: v }));
                                if (isMissing(r)) setSelected((s) => toggle(s, r.field, typeof v === "string" ? v.trim() !== "" : v != null));
                              }}
                            /> : <ValueDisplay field={r.field} value={values[r.field]} />}</div>
                        <Button variant="ghost" size="icon-sm" aria-label={t("actions.edit")} onClick={() => setEditing(isEditing ? null : r.field)}>
                          {isEditing ? <ChevronDown /> : <PencilLine />}
                        </Button>
                      </div>
                      {c.alternatives?.length ? (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                          <span>{t("extraction.review.alternatives")}:</span>
                          {c.alternatives.map((a, i) => (
                            <button key={i} type="button" className="rounded border border-line px-1.5 py-0.5 hover:bg-subtle" onClick={() => setValues((s) => ({ ...s, [r.field]: a.value }))} title={a.evidence ?? undefined}>
                              {formatValue(a.value)} · {t(`extraction.source.${a.source}`)}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {!compact && !isMissing(r) ? <EvidenceLine evidence={c.evidence} /> : null}
                    </div>
                    <Checkbox className="mt-0.5" aria-label={t("extraction.review.reviewLater")} title={t("extraction.review.reviewLater")} checked={later.has(r.field)} onCheckedChange={(v) => setLater((s) => toggle(s, r.field, !!v))} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {result.description_text ? (
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <Checkbox checked={includeDescription} onCheckedChange={(v) => setIncludeDescription(!!v)} />
          {t("extraction.review.includeDescription")} <span className="text-xs text-ink-4">({t("common.characters", { count: result.description_text.length })})</span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
          {t("actions.dismiss")}
        </Button>
        <Button variant="primary" onClick={() => apply.mutate()} disabled={apply.isPending || (selected.size === 0 && !includeDescription)}>
          {apply.isPending ? t("actions.saving") : t("extraction.review.applySelected")}
        </Button>
      </div>
    </div>
  );
}

/** AI drafts: whether a value is verified in the posting, researched on the web, or inferred. */
function BasisBadge({ basis, sourceUrl }: { basis: "posting" | "web" | "inferred"; sourceUrl: string | null }) {
  const { t } = useTranslation();
  if (basis === "posting") return <Badge tone="ok">{t("drafts.basis.posting")}</Badge>;
  if (basis === "web") {
    let host = "";
    try {
      host = sourceUrl ? new URL(sourceUrl).hostname : "";
    } catch {
      host = "";
    }
    return (
      <Badge tone="info" title={sourceUrl ?? undefined}>
        {t("drafts.basis.web", { site: host })}
      </Badge>
    );
  }
  return <Badge tone="warn">{t("drafts.basis.inferred")}</Badge>;
}

function EvidenceLine({ evidence }: { evidence: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  if (!evidence) return <p className="text-[11px] text-ink-4">{t("extraction.review.noEvidence")}</p>;
  const short = evidence.length > 140;
  return (
    <div className="text-xs text-ink-3">
      <button type="button" className="inline-flex items-center gap-0.5 font-medium text-ink-3 hover:text-ink" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {t("extraction.review.evidence")}
      </button>
      {open || !short ? (
        <blockquote className="mt-1 rounded border-l-2 border-accent/40 bg-subtle px-2 py-1 leading-relaxed" lang="">
          “{evidence}”
        </blockquote>
      ) : null}
    </div>
  );
}
