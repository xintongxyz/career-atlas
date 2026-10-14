import { EMPLOYMENT_TYPES, LIST_FIELDS, POSTING_STATUSES, SALARY_PERIODS, SALARY_SOURCES, SENIORITY_LEVELS, VISA_SPONSORSHIP, WORK_MODES, type ExtractableField } from "@shared/constants";
import type { Salary } from "@shared/schemas";
import { useTranslation } from "react-i18next";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { useLocaleContext } from "@/hooks/useMe";
import { fromDateInput, toDateInput } from "@/lib/format";

const ENUMS: Partial<Record<ExtractableField, { values: readonly string[]; ns: string }>> = {
  seniority: { values: SENIORITY_LEVELS, ns: "seniority" },
  employment_type: { values: EMPLOYMENT_TYPES, ns: "employmentType" },
  work_mode: { values: WORK_MODES, ns: "workMode" },
  visa_sponsorship: { values: VISA_SPONSORSHIP, ns: "visa" },
  posting_status: { values: POSTING_STATUSES, ns: "postingStatus" },
};
const DATE_FIELDS: ExtractableField[] = ["posted_at", "deadline_at"];
const LONG_TEXT: ExtractableField[] = ["summary", "work_authorization", "visa_sponsorship_text", "citizenship_restriction", "residency_restriction", "security_clearance", "location_restriction", "travel_requirement", "relocation_requirement", "years_experience_text"];

/** Renders a read-only, human-friendly value for any extractable field. */
export function ValueDisplay({ field, value }: { field: ExtractableField; value: unknown }) {
  const { t, lang, tz } = useLocaleContext();
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return <span className="text-ink-4">—</span>;
  const e = ENUMS[field];
  if (e && typeof value === "string") return <span>{t(`${e.ns}.${value}`)}</span>;
  if (DATE_FIELDS.includes(field) && typeof value === "number") return <span>{new Intl.DateTimeFormat(lang, { timeZone: tz, dateStyle: "medium" }).format(value)}</span>;
  if (field === "salary") {
    const s = value as Salary;
    const range = [s.min, s.max].filter((x) => x != null).map((n) => new Intl.NumberFormat(lang).format(n!)).join("–");
    return (
      <span className="tabular">
        {range || s.text} {s.currency ?? <span className="text-warn">({t("salary.currency")}?)</span>} {s.period !== "unknown" ? t(`salary.per.${s.period}`) : <span className="text-warn">({t("salary.period.unknown")})</span>}
      </span>
    );
  }
  if (Array.isArray(value))
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {(value as string[]).slice(0, 12).map((v, i) => (
          <li key={i}>{v}</li>
        ))}
        {value.length > 12 ? <li className="list-none text-ink-4">+{value.length - 12}</li> : null}
      </ul>
    );
  return <span className="break-words">{String(value)}</span>;
}

/** Editable input for any extractable field value. */
export function ValueEditor({ field, value, onChange, id }: { field: ExtractableField; value: unknown; onChange: (v: unknown) => void; id?: string }) {
  const { t, tz } = useLocaleContext();
  const label = t(`fields.${field}`);
  const e = ENUMS[field];
  if (e) {
    return (
      <NativeSelect id={id} aria-label={label} value={(value as string) ?? ""} onChange={(ev) => onChange(ev.target.value)}>
        {e.values.map((v) => (
          <option key={v} value={v}>
            {t(`${e.ns}.${v}`)}
          </option>
        ))}
      </NativeSelect>
    );
  }
  if (DATE_FIELDS.includes(field)) {
    return <Input id={id} aria-label={label} type="date" value={toDateInput(value as number | null, tz)} onChange={(ev) => onChange(fromDateInput(ev.target.value, tz, "23:59"))} />;
  }
  if (field === "years_experience_min") {
    return <Input id={id} aria-label={label} type="number" min={0} max={50} value={(value as number | null) ?? ""} onChange={(ev) => onChange(ev.target.value === "" ? null : Number(ev.target.value))} />;
  }
  if (field === "salary") return <SalaryEditor value={value as Salary | null} onChange={onChange} />;
  if (LIST_FIELDS.includes(field)) {
    return (
      <Textarea
        id={id} aria-label={label}
        rows={Math.min(8, Math.max(3, ((value as string[]) ?? []).length + 1))}
        value={((value as string[]) ?? []).join("\n")}
        onChange={(ev) => onChange(ev.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
        aria-describedby={id ? `${id}-hint` : undefined}
      />
    );
  }
  if (LONG_TEXT.includes(field)) return <Textarea id={id} aria-label={label} rows={2} value={(value as string) ?? ""} onChange={(ev) => onChange(ev.target.value)} />;
  return <Input id={id} aria-label={label} value={(value as string) ?? ""} onChange={(ev) => onChange(ev.target.value)} />;
}

export function SalaryEditor({ value, onChange }: { value: Salary | null; onChange: (v: Salary | null) => void }) {
  const { t } = useTranslation();
  const s: Salary = value ?? { min: null, max: null, currency: null, period: "unknown", source: "employer", text: null, compensation_type: null };
  const set = (patch: Partial<Salary>) => onChange({ ...s, ...patch });
  const num = (v: string) => (v === "" ? null : Number(v));
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <Input aria-label={t("salary.min")} placeholder={t("salary.min")} type="number" min={0} value={s.min ?? ""} onChange={(e) => set({ min: num(e.target.value) })} />
      <Input aria-label={t("salary.max")} placeholder={t("salary.max")} type="number" min={0} value={s.max ?? ""} onChange={(e) => set({ max: num(e.target.value) })} />
      <Input aria-label={t("salary.currency")} placeholder="CAD" maxLength={3} value={s.currency ?? ""} onChange={(e) => set({ currency: e.target.value.toUpperCase() || null })} />
      <NativeSelect aria-label={t("salary.period.unknown")} value={s.period} onChange={(e) => set({ period: e.target.value as Salary["period"] })}>
        {SALARY_PERIODS.map((p) => (
          <option key={p} value={p}>
            {t(`salary.period.${p}`)}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect aria-label={t("salary.sourceLabel")} value={s.source} onChange={(e) => set({ source: e.target.value as Salary["source"] })}>
        {SALARY_SOURCES.map((p) => (
          <option key={p} value={p}>
            {t(`salary.source.${p}`)}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
