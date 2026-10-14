import { EMPLOYMENT_TYPES, LIMITS, PRIORITIES, SENIORITY_LEVELS, VISA_SPONSORSHIP, WORK_MODES } from "@shared/constants";
import { createJobSchema, updateJobSchema, type JobFields, type Salary, type SavedJobFields } from "@shared/schemas";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { TagInput } from "@/components/ui/tag-input";
import { useLocaleContext } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { fromDateInput, toDateInput } from "@/lib/format";
import { markUnsentDraft } from "@/lib/save-state";
import { cn } from "@/lib/utils";
import { SalaryEditor } from "./value-editor";

const LISTS = [
  "additional_locations",
  "remote_eligible_regions",
  "benefits",
  "responsibilities",
  "required_qualifications",
  "preferred_qualifications",
  "technical_skills",
  "soft_skills",
  "tools",
  "education_requirements",
  "language_requirements",
  "certifications",
  "other_requirements",
  "licences",
  "other_hard_requirements",
] as const;
type ListKey = (typeof LISTS)[number];

type FormValues = Omit<JobFields, ListKey | "posted_at" | "deadline_at" | "salary"> & {
  [K in ListKey]: string;
} & {
  posted_at: string;
  deadline_at: string;
  salary: Salary | null;
  priority: string;
  is_starred: boolean;
  interest_level: string;
  fit_assessment: string;
  next_action: string;
  follow_up_at: string;
  tags: string[];
  initial_status: "saved" | "preparing" | "applied";
};

export type JobFormSubmit = { job: JobFields; personal?: SavedJobFields; initial_status?: "saved" | "preparing" | "applied" };

function toForm(job: Partial<JobFields> | undefined, tz: string): FormValues {
  const j = (job ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...j };
  for (const k of LISTS) out[k] = ((j[k] as string[] | undefined) ?? []).join("\n");
  out.posted_at = toDateInput(j.posted_at as number | null, tz);
  out.deadline_at = toDateInput(j.deadline_at as number | null, tz);
  for (const k of Object.keys(out)) if (out[k] === null) out[k] = k === "salary" ? null : "";
  out.work_mode ??= "unspecified";
  out.employment_type ??= "unknown";
  out.seniority ??= "unknown";
  out.visa_sponsorship ??= "unknown";
  out.priority = "";
  out.is_starred = false;
  out.interest_level = "";
  out.fit_assessment = "";
  out.next_action = "";
  out.follow_up_at = "";
  out.tags = [];
  out.initial_status = "saved";
  return out as FormValues;
}

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section className="border-b border-line py-3 last:border-0">
      <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        <ChevronDown className={cn("size-4 text-ink-4 transition-transform", !open && "-rotate-90")} />
      </button>
      {open ? <div className="mt-3 grid gap-3 sm:grid-cols-2">{children}</div> : null}
    </section>
  );
}

export function JobForm({ mode, initial, onSubmit, busy, onCancel }: { mode: "create" | "edit"; initial?: Partial<JobFields>; onSubmit: (v: JobFormSubmit) => void; busy?: boolean; onCancel?: () => void }) {
  const { t, tz } = useLocaleContext();
  const { i18n } = useTranslation();
  const tagsQuery = useQuery({ queryKey: ["tags"], queryFn: () => api.get<{ items: { name: string }[] }>("/api/tags"), enabled: mode === "create" });
  const form = useForm<FormValues>({ defaultValues: toForm(initial, tz) });
  const { register, control, handleSubmit, setError, formState } = form;
  const dirtyKey = React.useId();
  React.useEffect(() => {
    markUnsentDraft(`job-form:${dirtyKey}`, formState.isDirty && !busy);
    return () => markUnsentDraft(`job-form:${dirtyKey}`, false);
  }, [formState.isDirty, busy, dirtyKey]);
  const formRef = React.useRef<HTMLFormElement>(null);

  const submit = handleSubmit((v) => {
    const job: Record<string, unknown> = {};
    const keys = Object.keys(v) as (keyof FormValues)[];
    for (const k of keys) {
      if (["priority", "is_starred", "interest_level", "fit_assessment", "next_action", "follow_up_at", "tags", "initial_status"].includes(k as string)) continue;
      job[k] = v[k];
    }
    for (const k of LISTS) job[k] = (v[k] ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    // A date input only holds the day: keep the exact original timestamp when the day is unchanged,
    // so saving the form never rewrites (or falsely "edits") a date the user didn't touch.
    const keepDate = (value: string, original: number | null | undefined, time: string) =>
      original != null && value === toDateInput(original, tz) ? original : fromDateInput(value, tz, time);
    job.posted_at = keepDate(v.posted_at, initial?.posted_at, "12:00");
    job.deadline_at = keepDate(v.deadline_at, initial?.deadline_at, "23:59");
    const sal = v.salary;
    job.salary = sal && (sal.min != null || sal.max != null || sal.text) ? sal : null;
    job.years_experience_min = v.years_experience_min === ("" as unknown) || v.years_experience_min == null ? null : Number(v.years_experience_min);
    if (!job.description_text) job.description_text = null;

    const personal: SavedJobFields = {
      priority: (v.priority || null) as SavedJobFields["priority"],
      is_starred: v.is_starred,
      interest_level: v.interest_level ? Number(v.interest_level) : null,
      fit_assessment: v.fit_assessment,
      next_action: v.next_action,
      follow_up_at: fromDateInput(v.follow_up_at, tz, "09:00"),
      tags: v.tags,
    };
    const parsed = mode === "create" ? createJobSchema.safeParse({ job, personal, initial_status: v.initial_status }) : updateJobSchema.safeParse({ job });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.filter((p) => p !== "job").join(".") as keyof FormValues;
        const msg = issue.message === "salary_min_gt_max" ? t("validation.salaryOrder") : issue.message === "invalid_url" ? t("validation.invalidUrl") : issue.code === "too_small" ? t("validation.required") : issue.message;
        setError(path, { message: msg });
      }
      return;
    }
    onSubmit({ job: parsed.data.job as JobFields, personal: mode === "create" ? personal : undefined, initial_status: v.initial_status });
  });

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && formRef.current?.contains(document.activeElement)) {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit]);

  const err = (k: keyof FormValues) => formState.errors[k]?.message as string | undefined;
  const text = (k: keyof FormValues, opts?: { long?: boolean; span?: boolean; type?: string; required?: boolean; placeholder?: string; hint?: string }) => (
    <Field label={t(`fields.${k}`)} htmlFor={`jf-${k}`} error={err(k)} className={opts?.span ? "sm:col-span-2" : undefined} hint={opts?.hint}>
      {opts?.long ? (
        <Textarea id={`jf-${k}`} rows={3} aria-invalid={!!err(k)} {...register(k)} />
      ) : (
        <Input id={`jf-${k}`} type={opts?.type ?? "text"} aria-invalid={!!err(k)} placeholder={opts?.placeholder} {...register(k, { required: opts?.required ? t("validation.required") : false })} />
      )}
    </Field>
  );
  const list = (k: ListKey, span = true) => (
    <Field label={t(`fields.${k}`)} htmlFor={`jf-${k}`} hint={k === "remote_eligible_regions" ? t("fieldHelp.remote_eligible_regions") : t("jobForm.listHelp")} className={span ? "sm:col-span-2" : undefined}>
      <Textarea id={`jf-${k}`} rows={3} {...register(k)} />
    </Field>
  );
  const select = (k: keyof FormValues, values: readonly string[], ns: string, hint?: string) => (
    <Field label={t(`fields.${k}`)} htmlFor={`jf-${k}`} hint={hint}>
      <NativeSelect id={`jf-${k}`} {...register(k)}>
        {values.map((v) => (
          <option key={v} value={v}>
            {t(`${ns}.${v}`)}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );

  return (
    <form ref={formRef} onSubmit={submit} noValidate lang={i18n.language}>
      <Section title={t("jobForm.sections.basics")}>
        {text("company_name", { required: true })}
        {text("company_website", { type: "url", placeholder: "https://" })}
        {text("title", { required: true, span: true })}
        {text("category")}
        {text("department")}
        {select("seniority", SENIORITY_LEVELS, "seniority")}
        {select("employment_type", EMPLOYMENT_TYPES, "employmentType")}
        {text("original_url", { type: "url", placeholder: "https://", span: true })}
        {text("apply_url", { type: "url", placeholder: "https://" })}
        {text("external_job_id")}
        {text("posted_at", { type: "date" })}
        {text("deadline_at", { type: "date" })}
        {mode === "create" ? (
          <Field label={t("jobForm.initialStatus")} htmlFor="jf-initial_status">
            <NativeSelect id="jf-initial_status" {...register("initial_status")}>
              {(["saved", "preparing", "applied"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
      </Section>

      <Section title={t("jobForm.sections.location")}>
        {select("work_mode", WORK_MODES, "workMode")}
        {text("hybrid_frequency")}
        {text("city")}
        {text("region")}
        {text("country")}
        {text("travel_requirement")}
        {list("additional_locations", false)}
        {list("remote_eligible_regions", false)}
        {text("relocation_requirement", { span: true })}
      </Section>

      <Section title={t("jobForm.sections.compensation")} defaultOpen={mode === "create"}>
        <Field label={t("fields.salary")} hint={t("fieldHelp.salary_source")} className="sm:col-span-2">
          <Controller control={control} name="salary" render={({ field }) => <SalaryEditor value={field.value} onChange={field.onChange} />} />
          {err("salary") ? <p className="mt-1 text-xs text-danger">{err("salary")}</p> : null}
        </Field>
        {text("bonus")}
        {text("commission")}
        {text("equity")}
        {list("benefits", false)}
        {text("compensation_notes", { long: true, span: true })}
      </Section>

      <Section title={t("jobForm.sections.requirements")} defaultOpen={mode === "edit"}>
        {list("responsibilities")}
        {list("required_qualifications")}
        {list("preferred_qualifications")}
        {list("technical_skills", false)}
        {list("tools", false)}
        {list("soft_skills", false)}
        {list("education_requirements", false)}
        {text("years_experience_min", { type: "number" })}
        {text("years_experience_text")}
        {list("language_requirements", false)}
        {list("certifications", false)}
        {list("other_requirements")}
      </Section>

      <Section title={t("jobForm.sections.eligibility")} defaultOpen={mode === "edit"}>
        {text("work_authorization", { long: true, span: true, hint: t("fieldHelp.work_authorization") })}
        {select("visa_sponsorship", VISA_SPONSORSHIP, "visa", t("fieldHelp.visa_sponsorship"))}
        {text("visa_sponsorship_text")}
        {text("citizenship_restriction")}
        {text("residency_restriction")}
        {text("security_clearance")}
        {text("location_restriction")}
        {list("licences", false)}
        {list("other_hard_requirements", false)}
      </Section>

      {mode === "create" ? (
        <Section title={t("jobForm.sections.personal")}>
          <Field label={t("fields.priority")} htmlFor="jf-priority">
            <NativeSelect id="jf-priority" {...register("priority")}>
              <option value="">{t("priority.none")}</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("fields.interest_level")} htmlFor="jf-interest" hint={t("fieldHelp.interest_level")}>
            <NativeSelect id="jf-interest" {...register("interest_level")}>
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("fields.tags")} hint={t("fieldHelp.tags")} className="sm:col-span-2">
            <Controller control={control} name="tags" render={({ field }) => <TagInput value={field.value} onChange={field.onChange} suggestions={tagsQuery.data?.items.map((x) => x.name)} />} />
          </Field>
          {text("next_action")}
          {text("follow_up_at", { type: "date" })}
          <Field label={t("fields.fit_assessment")} htmlFor="jf-fit" hint={t("fieldHelp.fit_assessment")} className="sm:col-span-2">
            <Textarea id="jf-fit" rows={2} {...register("fit_assessment")} />
          </Field>
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <Controller control={control} name="is_starred" render={({ field }) => <Checkbox checked={field.value} onCheckedChange={(c) => field.onChange(!!c)} />} />
            {t("fields.is_starred")}
          </label>
        </Section>
      ) : null}

      <Section title={t("jobForm.sections.description")} defaultOpen={mode === "create"}>
        <Field label={t("fields.description_text")} htmlFor="jf-desc" className="sm:col-span-2">
          <Textarea id="jf-desc" rows={8} maxLength={LIMITS.jdMaxChars} {...register("description_text")} />
        </Field>
      </Section>

      <div className="sticky bottom-[-16px] -mx-5 -mb-4 mt-2 flex items-center justify-between gap-2 border-t border-line bg-surface/95 px-5 py-3 backdrop-blur">
        <span className="hidden text-xs text-ink-4 sm:block">{t("jobForm.saveShortcut")}</span>
        <div className="ml-auto flex gap-2">
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              {t("actions.cancel")}
            </Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t("actions.saving") : t("actions.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
