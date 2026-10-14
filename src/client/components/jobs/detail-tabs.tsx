import { MANUAL_EVENT_TYPES, PRIORITIES, type EventType } from "@shared/constants";
import type { ApplicationDTO, ContactDTO, EventDTO, NoteDTO, ReminderDTO } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, FileText, History, Paperclip, Pencil, Plus, RotateCcw, Search, Send, Trash2, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { eventText } from "@/pages/dashboard";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, EmptyState, SectionTitle, Skeleton } from "@/components/ui/misc";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/overlay";
import { TagInput } from "@/components/ui/tag-input";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs } from "@/hooks/useJobMutations";
import { useLocaleContext } from "@/hooks/useMe";
import { api, qs } from "@/lib/api";
import { formatDate, formatDateTime, formatRelative, fromDateInput, fromDateTimeInput, locationText, toDateInput, toDateTimeInput } from "@/lib/format";
import { markUnsentDraft, useAutosaveText } from "@/lib/save-state";
import { cn } from "@/lib/utils";
import { displayCompany, SalaryText, STATUS_DOT } from "./badges";
import { ChipList, DocumentSelect, FieldRow, ListBlock, useDocuments, type DetailCtx } from "./detail-parts";
import { AiOptIn } from "./ai-opt-in";
import { StatusDialog } from "./status-control";
import type { PipelineStatus } from "@shared/constants";

function usePatchJob(id: string) {
  const invalidate = useInvalidateJobs();
  const onError = useToastError();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/jobs/${id}`, body),
    onSuccess: () => {
      toast.success(t("jobForm.updated"));
      void invalidate();
    },
    onError,
  });
}

// ---------------------------------------------------------------- overview

export function OverviewTab({ ctx }: { ctx: DetailCtx }) {
  const { t, lang, tz } = useLocaleContext();
  const p = ctx.job.posting;
  return (
    <div className="@container space-y-6">
      {p.summary ? (
        <section>
          <div className="flex items-center gap-1">
            <SectionTitle>{t("fields.summary")}</SectionTitle>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{p.summary}</p>
        </section>
      ) : null}
      <div className="grid gap-6 @3xl:grid-cols-2">
        <section>
          <SectionTitle>{t("job.overview.details")}</SectionTitle>
          <dl className="mt-1.5">
            <FieldRow ctx={ctx} field="company_name" label={t("fields.company_name")}>
              {displayCompany(ctx.job.company.name, t)}
            </FieldRow>
            <FieldRow ctx={ctx} field="company_website" label={t("fields.company_website")}>
              {ctx.job.company.website ? (
                <a href={ctx.job.company.website} target="_blank" rel="noopener noreferrer nofollow" className="text-accent hover:underline">
                  {ctx.job.company.domain ?? ctx.job.company.website}
                </a>
              ) : null}
            </FieldRow>
            <FieldRow ctx={ctx} field="category" label={t("fields.category")}>
              {p.category}
            </FieldRow>
            <FieldRow ctx={ctx} field="department" label={t("fields.department")}>
              {p.department}
            </FieldRow>
            <FieldRow ctx={ctx} field="seniority" label={t("fields.seniority")} empty={!p.seniority || p.seniority === "unknown"}>
              {t(`seniority.${p.seniority}`)}
            </FieldRow>
            <FieldRow ctx={ctx} field="employment_type" label={t("fields.employment_type")} empty={!p.employment_type || p.employment_type === "unknown"}>
              {t(`employmentType.${p.employment_type}`)}
            </FieldRow>
            <FieldRow ctx={ctx} field="posted_at" label={t("fields.posted_at")}>
              {p.posted_at ? formatDate(p.posted_at, lang, tz) : null}
            </FieldRow>
            <FieldRow ctx={ctx} field="posting_status" label={t("fields.posting_status")} empty={p.posting_status === "unknown"}>
              {t(`postingStatus.${p.posting_status}`)}
            </FieldRow>
            <FieldRow ctx={ctx} label={t("fields.source_platform")}>
              {t(`platform.${p.source_platform}`)}
            </FieldRow>
            <FieldRow ctx={ctx} label={t("fields.external_job_id")}>
              {p.external_job_id}
            </FieldRow>
          </dl>
        </section>
        <section className="space-y-6">
          <div>
            <SectionTitle>{t("job.overview.location")}</SectionTitle>
            <dl className="mt-1.5">
              <FieldRow ctx={ctx} field="work_mode" label={t("fields.work_mode")} empty={p.work_mode === "unspecified"}>
                {t(`workMode.${p.work_mode}`)}
              </FieldRow>
              <FieldRow ctx={ctx} field="city" label={t("fields.location")}>
                {locationText(p)}
              </FieldRow>
              <FieldRow ctx={ctx} field="hybrid_frequency" label={t("fields.hybrid_frequency")}>
                {p.hybrid_frequency}
              </FieldRow>
              <FieldRow ctx={ctx} field="remote_eligible_regions" label={t("fields.remote_eligible_regions")}>
                {p.remote_eligible_regions?.length ? p.remote_eligible_regions.join(", ") : null}
              </FieldRow>
              <FieldRow ctx={ctx} field="additional_locations" label={t("fields.additional_locations")}>
                {p.additional_locations?.length ? p.additional_locations.join("; ") : null}
              </FieldRow>
              <FieldRow ctx={ctx} field="travel_requirement" label={t("fields.travel_requirement")}>
                {p.travel_requirement}
              </FieldRow>
              <FieldRow ctx={ctx} field="relocation_requirement" label={t("fields.relocation_requirement")}>
                {p.relocation_requirement}
              </FieldRow>
            </dl>
          </div>
          <div>
            <SectionTitle>{t("job.overview.compensation")}</SectionTitle>
            <dl className="mt-1.5">
              <FieldRow ctx={ctx} field="salary" label={t("fields.salary")} empty={false}>
                <SalaryText salary={p.salary} />
                {p.salary && p.salary.source !== "employer" && p.salary.source !== "unknown" ? <Badge tone="warn" className="ml-1.5">{t(`salary.source.${p.salary.source}`)}</Badge> : null}
                {p.salary?.text ? <p className="mt-0.5 text-xs text-ink-3">{p.salary.text}</p> : null}
              </FieldRow>
              <FieldRow ctx={ctx} field="bonus" label={t("fields.bonus")}>
                {p.bonus}
              </FieldRow>
              <FieldRow ctx={ctx} field="commission" label={t("fields.commission")}>
                {p.commission}
              </FieldRow>
              <FieldRow ctx={ctx} field="equity" label={t("fields.equity")}>
                {p.equity}
              </FieldRow>
              <FieldRow ctx={ctx} label={t("fields.compensation_notes")}>
                {p.compensation_notes}
              </FieldRow>
            </dl>
          </div>
        </section>
      </div>
      <ListBlock ctx={ctx} field="benefits" title={t("fields.benefits")} items={p.benefits} />
      <ListBlock ctx={ctx} field="responsibilities" title={t("fields.responsibilities")} items={p.responsibilities} />
      <PersonalSection ctx={ctx} />
    </div>
  );
}

function PersonalSection({ ctx }: { ctx: DetailCtx }) {
  const { t } = useTranslation();
  const patch = usePatchJob(ctx.job.id);
  const fit = useAutosaveText(`fit:${ctx.job.id}`, ctx.job.personal.fit_assessment ?? "", (v) => patch.mutate({ personal: { fit_assessment: v } }));
  return (
    <section className="rounded-lg border border-line bg-canvas/60 p-4">
      <SectionTitle>{t("job.overview.personal")}</SectionTitle>
      <div className="mt-3 grid gap-3 @xl:grid-cols-2">
        <Field label={t("fields.interest_level")} htmlFor="p-interest" hint={t("fieldHelp.interest_level")}>
          <NativeSelect id="p-interest" value={ctx.job.personal.interest_level ?? ""} onChange={(e) => patch.mutate({ personal: { interest_level: e.target.value ? Number(e.target.value) : null } })}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t("fields.fit_score")} htmlFor="p-fitscore">
          <NativeSelect id="p-fitscore" value={ctx.job.personal.fit_score ?? ""} onChange={(e) => patch.mutate({ personal: { fit_score: e.target.value ? Number(e.target.value) : null } })}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t("fields.fit_assessment")} htmlFor="p-fit" hint={t("fieldHelp.fit_assessment")} className="sm:col-span-2">
          <Textarea id="p-fit" rows={3} value={fit.value} onChange={(e) => fit.onChange(e.target.value)} onBlur={fit.onBlur} />
        </Field>
        <Field label={t("fields.tags")} hint={t("fieldHelp.tags")} className="sm:col-span-2">
          <TagInput value={ctx.job.tags.map((x) => x.name)} onChange={(tags) => patch.mutate({ personal: { tags } })} />
        </Field>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- requirements

export function RequirementsTab({ ctx }: { ctx: DetailCtx }) {
  const { t } = useTranslation();
  const p = ctx.job.posting;
  const any =
    p.required_qualifications?.length || p.preferred_qualifications?.length || p.technical_skills?.length || p.tools?.length || p.education_requirements?.length || p.language_requirements?.length || p.years_experience_text || p.certifications?.length || p.other_requirements?.length;
  return (
    <div className="space-y-6">
      {!any ? <p className="text-[13px] text-ink-3">{t("job.requirements.empty")}</p> : null}
      <dl>
        <FieldRow ctx={ctx} field="years_experience_min" label={t("fields.years_experience_min")}>
          {p.years_experience_min != null ? p.years_experience_min : null}
        </FieldRow>
        <FieldRow ctx={ctx} field="years_experience_text" label={t("fields.years_experience_text")}>
          {p.years_experience_text}
        </FieldRow>
      </dl>
      <ListBlock ctx={ctx} field="required_qualifications" title={t("fields.required_qualifications")} items={p.required_qualifications} />
      <ListBlock ctx={ctx} field="preferred_qualifications" title={t("fields.preferred_qualifications")} items={p.preferred_qualifications} />
      {(["technical_skills", "tools", "soft_skills"] as const).map((f) =>
        p[f]?.length ? (
          <section key={f} className="space-y-1.5">
            <h3 className="text-[13px] font-semibold">{t(`fields.${f}`)}</h3>
            <ChipList items={p[f]} />
          </section>
        ) : null,
      )}
      <ListBlock ctx={ctx} field="education_requirements" title={t("fields.education_requirements")} items={p.education_requirements} />
      <ListBlock ctx={ctx} field="language_requirements" title={t("fields.language_requirements")} items={p.language_requirements} />
      <ListBlock ctx={ctx} field="certifications" title={t("fields.certifications")} items={p.certifications} />
      <ListBlock ctx={ctx} field="other_requirements" title={t("fields.other_requirements")} items={p.other_requirements} />
      <section>
        <SectionTitle>{t("jobForm.sections.eligibility")}</SectionTitle>
        <dl className="mt-1.5">
          <FieldRow ctx={ctx} field="work_authorization" label={t("fields.work_authorization")}>
            {p.work_authorization}
          </FieldRow>
          <FieldRow ctx={ctx} field="visa_sponsorship" label={t("fields.visa_sponsorship")} empty={p.visa_sponsorship === "unknown"}>
            {t(`visa.${p.visa_sponsorship}`)}
          </FieldRow>
          <FieldRow ctx={ctx} field="visa_sponsorship_text" label={t("fields.visa_sponsorship_text")}>
            {p.visa_sponsorship_text}
          </FieldRow>
          <FieldRow ctx={ctx} field="citizenship_restriction" label={t("fields.citizenship_restriction")}>
            {p.citizenship_restriction}
          </FieldRow>
          <FieldRow ctx={ctx} field="residency_restriction" label={t("fields.residency_restriction")}>
            {p.residency_restriction}
          </FieldRow>
          <FieldRow ctx={ctx} field="security_clearance" label={t("fields.security_clearance")}>
            {p.security_clearance}
          </FieldRow>
          <FieldRow ctx={ctx} field="location_restriction" label={t("fields.location_restriction")}>
            {p.location_restriction}
          </FieldRow>
          <FieldRow ctx={ctx} field="licences" label={t("fields.licences")}>
            {p.licences?.length ? p.licences.join("; ") : null}
          </FieldRow>
          <FieldRow ctx={ctx} field="other_hard_requirements" label={t("fields.other_hard_requirements")}>
            {p.other_hard_requirements?.length ? p.other_hard_requirements.join("; ") : null}
          </FieldRow>
        </dl>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- original JD

type Snapshot = { id: string; method: string; requested_url: string | null; final_url: string | null; title: string | null; text: string; fetched_at: number };

function highlight(text: string, q: string) {
  if (!q.trim()) return text;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="rounded bg-warn-soft px-0.5 text-ink">{part}</mark> : part));
}

export function OriginalTab({ ctx, onExtract }: { ctx: DetailCtx; onExtract: (extractionId: string) => void }) {
  const { t, lang, tz } = useLocaleContext();
  const onError = useToastError();
  const snaps = useQuery({ queryKey: ["job", ctx.job.id, "snapshots"], queryFn: () => api.get<{ items: Snapshot[] }>(`/api/jobs/${ctx.job.id}/snapshots`) });
  const [selected, setSelected] = React.useState<string | "current">("current");
  const [q, setQ] = React.useState("");
  const [paste, setPaste] = React.useState("");
  const [pasteAi, setPasteAi] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const snap = selected === "current" ? null : snaps.data?.items.find((s) => s.id === selected);
  const text = snap ? snap.text : ctx.job.posting.description_text;
  const matches = q.trim() && text ? text.toLowerCase().split(q.trim().toLowerCase()).length - 1 : 0;
  const extract = useMutation({
    mutationFn: () => api.post<{ extraction_id: string }>(`/api/jobs/${ctx.job.id}/extract-text`, { text: paste, use_ai: pasteAi || undefined }),
    onSuccess: (r) => onExtract(r.extraction_id),
    onError,
  });

  if (!text) {
    return (
      <div className="space-y-3">
        <EmptyState icon={<FileText />} title={t("job.original.empty")} body={t("job.original.emptyHelp")} />
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            extract.mutate();
          }}
        >
          <Textarea rows={8} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t("quickAdd.pastePlaceholder")} aria-label={t("extraction.pasteFallback")} />
          <AiOptIn id="paste-ai" checked={pasteAi} onChange={setPasteAi} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={paste.trim().length < 40 || extract.isPending}>
              {t("quickAdd.saveAndExtract")}
            </Button>
          </div>
        </form>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-4" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("job.original.searchPlaceholder")} className="pl-8" aria-label={t("job.original.searchPlaceholder")} />
        </div>
        {q ? <span className="text-xs text-ink-3">{t("job.original.matches", { count: matches })}</span> : null}
        {snaps.data && snaps.data.items.length > 0 ? (
          <NativeSelect className="w-60" value={selected} onChange={(e) => setSelected(e.target.value)} aria-label={t("job.original.history")}>
            <option value="current">{t("job.original.current")}</option>
            {snaps.data.items.map((s) => (
              <option key={s.id} value={s.id}>
                {formatDateTime(s.fetched_at, lang, tz)} · {t(`job.original.method.${s.method}`)}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("actions.copied") : t("job.copyJd")}
        </Button>
      </div>
      {snap ? (
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          <History className="size-3.5" />
          {t("job.original.snapshotFrom", { date: formatDateTime(snap.fetched_at, lang, tz), method: t(`job.original.method.${snap.method}`) })}
          {snap.requested_url ? (
            <a href={snap.requested_url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-0.5 text-accent hover:underline">
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </p>
      ) : null}
      <article lang={ctx.job.posting.content_language ?? undefined} className="jd-text max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-canvas/50 p-4 text-[13px] text-ink-2 scrollbar-thin">
        {highlight(text, q)}
      </article>
      <p className="text-xs text-ink-4">{t("job.original.sourceStillAvailable")}</p>
    </div>
  );
}

// ---------------------------------------------------------------- application

export function ApplicationTab({ ctx }: { ctx: DetailCtx }) {
  const { t, lang, tz } = useLocaleContext();
  const app = ctx.job.application;
  const invalidate = useInvalidateJobs();
  const onError = useToastError();
  const [applyOpen, setApplyOpen] = React.useState(false);
  const save = useMutation({
    mutationFn: (body: Partial<ApplicationDTO>) => api.patch(`/api/jobs/${ctx.job.id}/application`, body),
    onSuccess: () => {
      toast.success(t("jobForm.updated"));
      void invalidate();
    },
    onError,
  });
  if (!app) {
    return (
      <div>
        <EmptyState
          icon={<Send />}
          title={t("job.notApplied")}
          body={t("job.applicationEmpty")}
          action={
            <Button variant="primary" onClick={() => setApplyOpen(true)}>
              {t("actions.markApplied")}
            </Button>
          }
        />
        <p className="text-center text-xs text-ink-4">{t("job.markAppliedHelp")}</p>
        <StatusDialog jobId={ctx.job.id} target={applyOpen ? "applied" : null} onClose={() => setApplyOpen(false)} />
      </div>
    );
  }
  const dateField = (key: keyof ApplicationDTO, withTime = false) => (
    <Field label={t(`fields.${key}`)} htmlFor={`app-${key}`}>
      <Input
        id={`app-${key}`}
        type={withTime ? "datetime-local" : "date"}
        defaultValue={withTime ? toDateTimeInput(app[key] as number | null, tz) : toDateInput(app[key] as number | null, tz)}
        key={`${key}-${app[key]}`}
        onBlur={(e) => {
          const v = withTime ? fromDateTimeInput(e.target.value, tz) : fromDateInput(e.target.value, tz);
          if (v !== app[key] && (v != null || key !== "applied_at")) save.mutate({ [key]: v });
        }}
      />
    </Field>
  );
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {dateField("applied_at", true)}
        <Field label={t("fields.applied_via")} htmlFor="app-via">
          <AutosaveInput id="app-via" autosaveKey={`via:${app.id}`} saved={app.applied_via ?? ""} onSave={(v) => save.mutate({ applied_via: v })} placeholder={t("job.appliedViaPlaceholder")} />
        </Field>
        {dateField("next_interview_at", true)}
        {dateField("offer_deadline_at")}
        {dateField("final_outcome_at")}
        <Field label={t("fields.next_follow_up_at")}>
          <p className="flex h-8 items-center text-[13px] text-ink-2">{app.next_follow_up_at ? formatDate(app.next_follow_up_at, lang, tz) : "—"}</p>
        </Field>
      </div>
      <div>
        <SectionTitle>{t("job.applicationTitle")}</SectionTitle>
        <dl className="mt-1.5 grid gap-x-6 sm:grid-cols-2">
          {(["first_response_at", "last_response_at", "reached_assessment_at", "reached_interview_at", "reached_offer_at", "last_activity_at"] as const).map((k) => (
            <div key={k} className="flex justify-between gap-3 border-b border-line/60 py-1.5 text-[13px]">
              <dt className="text-ink-3">{k.startsWith("reached_") ? t(`status.${k.replace("reached_", "").replace("_at", "")}`) : t(`fields.${k}`)}</dt>
              <dd className="tabular text-ink-2">{app[k] ? formatDate(app[k] as number, lang, tz) : "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("fields.resume_document_id")} htmlFor="app-resume">
          <DocumentSelect id="app-resume" kind="resume" label={t("fields.resume_document_id")} value={app.resume_document_id} onChange={(v) => save.mutate({ resume_document_id: v })} />
        </Field>
        <Field label={t("fields.cover_letter_document_id")} htmlFor="app-cover">
          <DocumentSelect id="app-cover" kind="cover_letter" label={t("fields.cover_letter_document_id")} value={app.cover_letter_document_id} onChange={(v) => save.mutate({ cover_letter_document_id: v })} />
        </Field>
      </div>
      <LinkedDocuments jobId={ctx.job.id} />
      <AppNotes app={app} onSave={(notes) => save.mutate({ notes })} />
    </div>
  );
}

function AutosaveInput({ autosaveKey, saved, onSave, ...props }: { autosaveKey: string; saved: string; onSave: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onBlur">) {
  const f = useAutosaveText(autosaveKey, saved, onSave);
  return <Input {...props} value={f.value} onChange={(e) => f.onChange(e.target.value)} onBlur={f.onBlur} />;
}

function AppNotes({ app, onSave }: { app: ApplicationDTO; onSave: (n: string) => void }) {
  const { t } = useTranslation();
  const notes = useAutosaveText(`app-notes:${app.id}`, app.notes ?? "", onSave);
  return (
    <Field label={t("fields.application_notes")} htmlFor="app-notes">
      <Textarea id="app-notes" rows={4} value={notes.value} onChange={(e) => notes.onChange(e.target.value)} onBlur={notes.onBlur} />
    </Field>
  );
}

function LinkedDocuments({ jobId }: { jobId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onError = useToastError();
  const docs = useDocuments();
  const linked = useQuery({ queryKey: ["job", jobId, "documents"], queryFn: () => api.get<{ items: { id: string; version_name: string; file_name: string; role: string }[] }>(`/api/jobs/${jobId}/documents`) });
  const [pick, setPick] = React.useState("");
  const attach = useMutation({
    mutationFn: () => api.post(`/api/jobs/${jobId}/documents`, { document_id: pick, role: "other" }),
    onSuccess: () => {
      toast.success(t("documents.attached"));
      setPick("");
      void qc.invalidateQueries({ queryKey: ["job", jobId, "documents"] });
      void qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError,
  });
  const detach = useMutation({
    mutationFn: (id: string) => api.delete(`/api/jobs/${jobId}/documents/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["job", jobId, "documents"] }),
    onError,
  });
  if (!docs.data?.items.length) return null;
  return (
    <section>
      <SectionTitle>{t("documents.linked")}</SectionTitle>
      <ul className="mt-1.5 space-y-1">
        {linked.data?.items.map((d) => (
          <li key={d.id} className="flex items-center gap-2 text-[13px]">
            <Paperclip className="size-3.5 text-ink-4" />
            <a href={`/api/documents/${d.id}/content`} className="flex-1 truncate hover:underline">
              {d.version_name}
            </a>
            <Button variant="ghost" size="icon-sm" aria-label={t("actions.delete")} onClick={() => detach.mutate(d.id)}>
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <NativeSelect value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t("documents.select")} className="max-w-xs">
          <option value="">{t("documents.select")}</option>
          {docs.data.items.filter((d) => !linked.data?.items.some((l) => l.id === d.id)).map((d) => (
            <option key={d.id} value={d.id}>
              {d.version_name}
            </option>
          ))}
        </NativeSelect>
        <Button disabled={!pick || attach.isPending} onClick={() => attach.mutate()}>
          {t("documents.attach")}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- activity

export function ActivityTab({ ctx }: { ctx: DetailCtx }) {
  const { t, lang, tz } = useLocaleContext();
  const invalidate = useInvalidateJobs();
  const qc = useQueryClient();
  const onError = useToastError();
  const events = useQuery({ queryKey: ["events", ctx.job.id], queryFn: () => api.get<{ items: EventDTO[] }>(`/api/jobs/${ctx.job.id}/events`) });
  const reminders = useQuery({ queryKey: ["reminders", ctx.job.id], queryFn: () => api.get<{ items: ReminderDTO[] }>(`/api/reminders${qs({ saved_job_id: ctx.job.id, status: "all" })}`) });
  const [form, setForm] = React.useState<{ type: EventType; occurred: string; scheduled: string; title: string; details: string }>({ type: "recruiter_replied", occurred: toDateTimeInput(Date.now(), tz), scheduled: "", title: "", details: "" });
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const refresh = () => {
    void invalidate();
    void qc.invalidateQueries({ queryKey: ["events", ctx.job.id] });
    void qc.invalidateQueries({ queryKey: ["reminders", ctx.job.id] });
  };
  const log = useMutation({
    mutationFn: () => api.post(`/api/jobs/${ctx.job.id}/events`, { type: form.type, occurred_at: fromDateTimeInput(form.occurred, tz), scheduled_for: form.scheduled ? fromDateTimeInput(form.scheduled, tz) : null, title: form.title || null, details: form.details || null }),
    onSuccess: () => {
      toast.success(t("job.activity.logged"));
      setForm((f) => ({ ...f, scheduled: "", title: "", details: "" }));
      refresh();
    },
    onError,
  });
  const editDate = useMutation({ mutationFn: (v: { id: string; at: number }) => api.patch(`/api/events/${v.id}`, { occurred_at: v.at }), onSuccess: refresh, onError });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/events/${id}`),
    onSuccess: () => {
      toast(t("job.activity.deleted"));
      setDeleting(null);
      refresh();
    },
    onError,
  });
  const toggleReminder = useMutation({ mutationFn: (r: ReminderDTO) => api.patch(`/api/reminders/${r.id}`, { completed: !r.completed_at }), onSuccess: refresh, onError });
  const deletable = (e: EventDTO) => (MANUAL_EVENT_TYPES as readonly string[]).includes(e.type) || e.type === "note_added";
  const schedulable = form.type === "interview_scheduled" || form.type === "follow_up_scheduled" || form.type === "offer_received";

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div>
        {events.isLoading ? (
          <Skeleton className="h-40" />
        ) : !events.data?.items.length ? (
          <p className="text-[13px] text-ink-3">{t("job.activity.empty")}</p>
        ) : (
          <ol className="relative space-y-0 border-l border-line pl-5">
            {events.data.items.map((e) => (
              <li key={e.id} className="group relative pb-4">
                <span className={cn("absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-surface", e.to_status ? STATUS_DOT[e.to_status as PipelineStatus] ?? "bg-ink-4" : "bg-line-strong")} />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <p className="text-[13px] font-medium text-ink">{eventText(e, t)}</p>
                  {e.scheduled_for ? <span className="text-xs text-ink-3">{t("events.scheduledFor", { date: formatDateTime(e.scheduled_for, lang, tz) })}</span> : null}
                  {e.type === "job_updated" && Array.isArray(e.metadata?.fields) ? <span className="text-xs text-ink-4">{t("events.fieldsChanged", { count: (e.metadata!.fields as string[]).length })}</span> : null}
                </div>
                {e.title && e.type !== "custom" ? <p className="text-[13px] text-ink-2">{e.title}</p> : null}
                {e.details ? <p className="whitespace-pre-wrap text-[13px] text-ink-2">{e.details}</p> : null}
                <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-4">
                  <time dateTime={new Date(e.occurred_at).toISOString()}>{formatDateTime(e.occurred_at, lang, tz)}</time>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" className="opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus:opacity-100" aria-label={t("job.activity.editDate")}>
                        <Pencil className="size-3" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64">
                      <form
                        className="space-y-2"
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          const v = new FormData(ev.currentTarget).get("at") as string;
                          const at = fromDateTimeInput(v, tz);
                          if (at) editDate.mutate({ id: e.id, at });
                        }}
                      >
                        <Field label={t("job.activity.editDate")} htmlFor={`ed-${e.id}`}>
                          <Input id={`ed-${e.id}`} name="at" type="datetime-local" defaultValue={toDateTimeInput(e.occurred_at, tz)} />
                        </Field>
                        <PopoverClose asChild>
                          <Button type="submit" size="sm" variant="primary">
                            {t("actions.save")}
                          </Button>
                        </PopoverClose>
                      </form>
                    </PopoverContent>
                  </Popover>
                  {deletable(e) ? (
                    <button type="button" className="opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus:opacity-100" aria-label={t("actions.delete")} onClick={() => setDeleting(e.id)}>
                      <Trash2 className="size-3" />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-ink-4">{t("job.activity.permanent")}</p>
      </div>
      <div className="space-y-5">
        <form
          className="space-y-2.5 rounded-lg border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            log.mutate();
          }}
        >
          <h3 className="text-[13px] font-semibold">{t("job.activity.logTitle")}</h3>
          <Field label={t("job.activity.eventType")} htmlFor="ev-type">
            <NativeSelect id="ev-type" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as EventType }))}>
              {MANUAL_EVENT_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {t(`events.${tp}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("job.activity.occurredAt")} htmlFor="ev-at">
            <Input id="ev-at" type="datetime-local" value={form.occurred} onChange={(e) => setForm((f) => ({ ...f, occurred: e.target.value }))} required />
          </Field>
          {schedulable ? (
            <Field label={form.type === "offer_received" ? t("fields.offer_deadline_at") : t("job.activity.scheduledFor")} htmlFor="ev-sched">
              <Input id="ev-sched" type="datetime-local" value={form.scheduled} onChange={(e) => setForm((f) => ({ ...f, scheduled: e.target.value }))} />
            </Field>
          ) : null}
          {form.type === "custom" ? (
            <Field label={t("reminders.titleLabel")} htmlFor="ev-title">
              <Input id="ev-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required />
            </Field>
          ) : null}
          <Field label={t("job.activity.details")} htmlFor="ev-details">
            <Textarea id="ev-details" rows={2} value={form.details} onChange={(e) => setForm((f) => ({ ...f, details: e.target.value }))} />
          </Field>
          <Button type="submit" variant="primary" size="sm" disabled={log.isPending}>
            <Plus />
            {t("actions.logEvent")}
          </Button>
        </form>
        <ReminderList reminders={reminders.data?.items ?? []} onToggle={(r) => toggleReminder.mutate(r)} jobId={ctx.job.id} onCreated={refresh} />
      </div>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t("common.confirmDeleteTitle")} body={t("common.confirmDeleteBody")} onConfirm={() => deleting && del.mutate(deleting)} busy={del.isPending} />
    </div>
  );
}

export function reminderTitle(r: { title: string; kind: string }, t: (k: string) => string) {
  const key = `reminders.defaults.${r.title}`;
  const v = t(key);
  return v !== key ? v : r.title;
}

function ReminderList({ reminders, onToggle, jobId, onCreated }: { reminders: ReminderDTO[]; onToggle: (r: ReminderDTO) => void; jobId: string; onCreated: () => void }) {
  const { t, lang, tz } = useLocaleContext();
  const onError = useToastError();
  const [title, setTitle] = React.useState("");
  const [due, setDue] = React.useState("");
  const create = useMutation({
    mutationFn: () => api.post("/api/reminders", { title, kind: "custom", due_at: fromDateTimeInput(due, tz), saved_job_id: jobId }),
    onSuccess: () => {
      toast.success(t("reminders.created"));
      setTitle("");
      setDue("");
      onCreated();
    },
    onError,
  });
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold">{t("reminders.title")}</h3>
      <ul className="space-y-1">
        {reminders.map((r) => (
          <li key={r.id} className="flex items-start gap-2 text-[13px]">
            <button type="button" onClick={() => onToggle(r)} className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border", r.completed_at ? "border-ok bg-ok text-white" : "border-line-strong")} aria-label={r.completed_at ? t("reminders.reopened") : t("actions.done")}>
              {r.completed_at ? <Check className="size-3" /> : null}
            </button>
            <div className={cn("min-w-0 flex-1", r.completed_at && "text-ink-4 line-through")}>
              <p className="truncate">{reminderTitle(r, t)}</p>
              <p className={cn("text-xs", !r.completed_at && r.due_at < Date.now() ? "text-warn" : "text-ink-4")}>{formatDateTime(r.due_at, lang, tz)}</p>
            </div>
          </li>
        ))}
      </ul>
      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (title && due) create.mutate();
        }}
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("reminders.titleLabel")} aria-label={t("reminders.titleLabel")} />
        <div className="flex gap-1.5">
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label={t("reminders.dueLabel")} />
          <Button type="submit" size="md" disabled={!title || !due}>
            <Plus />
          </Button>
        </div>
      </form>
      <p className="text-[11px] text-ink-4">{t("reminders.followUpNote")}</p>
    </section>
  );
}

// ---------------------------------------------------------------- notes

export function NotesTab({ jobId }: { jobId: string }) {
  const { t, lang, tz } = useLocaleContext();
  const qc = useQueryClient();
  const onError = useToastError();
  const notes = useQuery({ queryKey: ["job", jobId, "notes"], queryFn: () => api.get<{ items: NoteDTO[] }>(`/api/jobs/${jobId}/notes`) });
  const [draft, setDraft] = React.useState("");
  // An unsent note counts as unsaved work: closing the tab asks first.
  React.useEffect(() => {
    markUnsentDraft(`note-draft:${jobId}`, draft.trim().length > 0);
    return () => markUnsentDraft(`note-draft:${jobId}`, false);
  }, [draft, jobId]);
  const [editing, setEditing] = React.useState<{ id: string; body: string } | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["job", jobId, "notes"] });
    void qc.invalidateQueries({ queryKey: ["events", jobId] });
  };
  const add = useMutation({
    mutationFn: () => api.post(`/api/jobs/${jobId}/notes`, { body: draft }),
    onSuccess: () => {
      setDraft("");
      toast.success(t("job.notesTab.saved"));
      refresh();
    },
    onError,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; body: string }) => api.patch(`/api/notes/${v.id}`, { body: v.body }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/notes/${id}`),
    onSuccess: () => {
      setDeleting(null);
      toast(t("job.notesTab.deleted"));
      refresh();
    },
    onError,
  });
  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) add.mutate();
        }}
        className="space-y-2"
      >
        <Textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("job.notesTab.placeholder")}
          aria-label={t("actions.addNote")}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
              e.preventDefault();
              if (draft.trim()) add.mutate();
            }
          }}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" size="sm" disabled={!draft.trim() || add.isPending}>
            {t("actions.addNote")}
          </Button>
        </div>
      </form>
      {notes.data?.items.length === 0 ? <p className="text-[13px] text-ink-3">{t("job.notesTab.empty")}</p> : null}
      <ul className="space-y-3">
        {notes.data?.items.map((n) => (
          <li key={n.id} className="group rounded-lg border border-line bg-surface p-3">
            {editing?.id === n.id ? (
              <div className="space-y-2">
                <Textarea rows={4} value={editing.body} onChange={(e) => setEditing({ id: n.id, body: e.target.value })} autoFocus />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    {t("actions.cancel")}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => update.mutate(editing)}>
                    {t("actions.save")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{n.body}</p>
                <div className="mt-2 flex items-center gap-2 text-xs text-ink-4">
                  <span title={formatDateTime(n.created_at, lang, tz)}>{formatRelative(n.created_at, lang)}</span>
                  <button type="button" className="opacity-0 hover:text-ink group-hover:opacity-100 focus:opacity-100" onClick={() => setEditing({ id: n.id, body: n.body })} aria-label={t("actions.edit")}>
                    <Pencil className="size-3" />
                  </button>
                  <button type="button" className="opacity-0 hover:text-danger group-hover:opacity-100 focus:opacity-100" onClick={() => setDeleting(n.id)} aria-label={t("actions.delete")}>
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t("common.confirmDeleteTitle")} body={t("common.confirmDeleteBody")} onConfirm={() => deleting && del.mutate(deleting)} busy={del.isPending} />
    </div>
  );
}

// ---------------------------------------------------------------- sidebar

export function DetailSidebar({ ctx, onRefresh }: { ctx: DetailCtx; onRefresh: () => void }) {
  const { t, lang, tz } = useLocaleContext();
  const p = ctx.job.posting;
  const personal = ctx.job.personal;
  const patch = usePatchJob(ctx.job.id);
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: () => api.get<{ items: ContactDTO[] }>("/api/contacts"), staleTime: 60_000 });
  const nextAction = useAutosaveText(`next:${ctx.job.id}`, personal.next_action ?? "", (v) => patch.mutate({ personal: { next_action: v } }));
  const restrictions = [
    p.work_authorization && { field: "work_authorization", text: p.work_authorization },
    p.visa_sponsorship !== "unknown" && { field: "visa_sponsorship", text: t(`visa.${p.visa_sponsorship}`) },
    p.citizenship_restriction && { field: "citizenship_restriction", text: p.citizenship_restriction },
    p.residency_restriction && { field: "residency_restriction", text: p.residency_restriction },
    p.security_clearance && { field: "security_clearance", text: p.security_clearance },
    p.location_restriction && { field: "location_restriction", text: p.location_restriction },
    p.remote_eligible_regions?.length && { field: "remote_eligible_regions", text: `${t("fields.remote_eligible_regions")}: ${p.remote_eligible_regions.join(", ")}` },
  ].filter(Boolean) as { field: string; text: string }[];
  const deadlineSoon = p.deadline_at && p.deadline_at > Date.now() && p.deadline_at - Date.now() < 7 * 86_400_000;

  const box = "rounded-lg border border-line bg-surface p-4 shadow-card";
  return (
    <aside className="space-y-4">
      <section className={box}>
        <SectionTitle>{t("job.sidebar.summary")}</SectionTitle>
        <dl className="mt-2 space-y-1.5 text-[13px]">
          <Row label={t("fields.salary")}>
            <SalaryText salary={p.salary} showSource />
          </Row>
          <Row label={t("fields.location")}>{locationText(p) || <span className="text-ink-4">{t("common.notSpecified")}</span>}</Row>
          <Row label={t("fields.work_mode")}>{t(`workMode.${p.work_mode}`)}</Row>
          <Row label={t("fields.employment_type")}>{t(`employmentType.${p.employment_type}`)}</Row>
          <Row label={t("fields.deadline_at")}>
            <span className={cn(deadlineSoon && "font-medium text-warn")}>{p.deadline_at ? formatDate(p.deadline_at, lang, tz) : <span className="text-ink-4">{t("common.notSpecified")}</span>}</span>
          </Row>
        </dl>
      </section>

      <section className={box}>
        <SectionTitle>{t("job.sidebar.restrictions")}</SectionTitle>
        {restrictions.length ? (
          <ul className="mt-2 space-y-1.5">
            {restrictions.map((r) => (
              <li key={r.field} className="border-l-2 border-warn/50 pl-2 text-[13px] leading-snug text-ink-2">
                <span className="block text-[11px] text-ink-4">{t(`fields.${r.field}`)}</span>
                {r.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-4">{t("job.sidebar.noRestrictions")}</p>
        )}
      </section>

      <section className={box}>
        <SectionTitle>{t("job.sidebar.nextAction")}</SectionTitle>
        <div className="mt-2 space-y-2">
          <Input value={nextAction.value} onChange={(e) => nextAction.onChange(e.target.value)} onBlur={nextAction.onBlur} placeholder={t("fields.next_action")} aria-label={t("fields.next_action")} />
          <Field label={t("fields.follow_up_at")} htmlFor="sb-follow">
            <Input id="sb-follow" type="date" key={personal.follow_up_at ?? "none"} defaultValue={toDateInput(personal.follow_up_at, tz)} onBlur={(e) => {
              const v = fromDateInput(e.target.value, tz, "09:00");
              if (v !== personal.follow_up_at) patch.mutate({ personal: { follow_up_at: v } });
            }} />
          </Field>
          <Field label={t("fields.priority")} htmlFor="sb-priority">
            <NativeSelect id="sb-priority" value={personal.priority ?? ""} onChange={(e) => patch.mutate({ personal: { priority: e.target.value || null } })}>
              <option value="">{t("priority.none")}</option>
              {PRIORITIES.map((pr) => (
                <option key={pr} value={pr}>
                  {t(`priority.${pr}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </section>

      <section className={box}>
        <SectionTitle>{t("job.sidebar.materials")}</SectionTitle>
        <div className="mt-2 space-y-2">
          <Field label={t("fields.resume_document_id")} htmlFor="sb-resume">
            <DocumentSelect id="sb-resume" kind="resume" label={t("fields.resume_document_id")} value={personal.resume_document_id} onChange={(v) => patch.mutate({ personal: { resume_document_id: v } })} />
          </Field>
          <Field label={t("fields.cover_letter_document_id")} htmlFor="sb-cover">
            <DocumentSelect id="sb-cover" kind="cover_letter" label={t("fields.cover_letter_document_id")} value={personal.cover_letter_document_id} onChange={(v) => patch.mutate({ personal: { cover_letter_document_id: v } })} />
          </Field>
        </div>
      </section>

      <section className={box}>
        <SectionTitle>{t("job.sidebar.contacts")}</SectionTitle>
        <div className="mt-2 space-y-2">
          {(["recruiter_contact_id", "referral_contact_id"] as const).map((k) => (
            <Field key={k} label={t(`fields.${k}`)} htmlFor={`sb-${k}`}>
              <NativeSelect id={`sb-${k}`} value={personal[k] ?? ""} onChange={(e) => patch.mutate({ personal: { [k]: e.target.value || null } })}>
                <option value="">{t("common.none")}</option>
                {contacts.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company_name ? ` · ${c.company_name}` : ""}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ))}
        </div>
      </section>

      <section className={box}>
        <SectionTitle>{t("job.sidebar.freshness")}</SectionTitle>
        <div className="mt-2 space-y-1.5 text-xs text-ink-3">
          <p>{p.last_checked_at ? t("job.sidebar.lastChecked", { when: formatRelative(p.last_checked_at, lang) }) : t("job.sidebar.neverChecked")}</p>
          <p>{t("job.sidebar.snapshots", { count: ctx.job.snapshot_count })}</p>
          {p.original_url ? (
            <Button variant="secondary" size="sm" onClick={onRefresh}>
              <RotateCcw />
              {t("actions.refresh")}
            </Button>
          ) : (
            <p>{t("job.noUrl")}</p>
          )}
        </div>
      </section>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

