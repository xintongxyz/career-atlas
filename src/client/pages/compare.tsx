import type { ComparisonPrefs } from "@shared/schemas";
import type { JobDetail, JobListItem, Paginated } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { GitCompare, Plus, X } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { MatchLevelBadge, useMatch } from "@/components/jobs/match-panel";
import { localizePosting, localizedTitle } from "@/lib/job-i18n";
import { CompanyAvatar, PriorityBadge, SalaryText, StatusBadge, displayCompany, displayTitle } from "@/components/jobs/badges";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Badge, Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlay";
import { useLocaleContext } from "@/hooks/useMe";
import { api, qs } from "@/lib/api";
import { formatDate, locationText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "./system";

type Criterion = "work_mode" | "location" | "salary" | "category" | "employment_type";
type Result = "match" | "partial" | "miss" | "unknown";
const VALUE: Record<Result, number> = { match: 1, partial: 0.5, miss: 0, unknown: 0 };

/** Transparent, preference-based ranking. Unknown values are excluded, never counted as a miss. */
export function scoreJob(job: JobDetail, prefs: ComparisonPrefs) {
  const p = job.posting;
  const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();
  const results: { criterion: Criterion; result: Result; weight: number }[] = [];
  const add = (criterion: Criterion, active: boolean, compute: () => Result) => {
    const weight = prefs.weights[criterion];
    if (!active || weight <= 0) return;
    results.push({ criterion, result: compute(), weight });
  };
  add("work_mode", prefs.preferred_work_modes.length > 0, () => (p.work_mode === "unspecified" ? "unknown" : prefs.preferred_work_modes.includes(p.work_mode!) ? "match" : "miss"));
  add("location", prefs.preferred_cities.length > 0, () => {
    const places = [p.city, ...(p.additional_locations ?? [])].filter(Boolean).map(lc);
    if (prefs.preferred_cities.some((c) => places.some((pl) => pl.includes(lc(c))))) return "match";
    if (p.work_mode === "remote") return "partial";
    return places.length ? "miss" : "unknown";
  });
  add("salary", prefs.min_salary != null && !!prefs.min_salary_currency, () => {
    const s = p.salary;
    if (!s || (s.min == null && s.max == null) || s.currency !== prefs.min_salary_currency || s.period !== prefs.min_salary_period) return "unknown";
    const top = s.max ?? s.min!;
    const bottom = s.min ?? s.max!;
    if (bottom >= prefs.min_salary!) return "match";
    if (top >= prefs.min_salary!) return "partial";
    return "miss";
  });
  add("category", prefs.preferred_categories.length > 0, () => {
    const hay = `${lc(p.category)} ${lc(p.title)} ${lc(p.department)}`;
    if (prefs.preferred_categories.some((c) => hay.includes(lc(c)))) return "match";
    return p.category ? "miss" : "unknown";
  });
  add("employment_type", prefs.preferred_employment_types.length > 0, () => (p.employment_type === "unknown" ? "unknown" : prefs.preferred_employment_types.includes(p.employment_type!) ? "match" : "miss"));
  const scored = results.filter((r) => r.result !== "unknown");
  const totalWeight = scored.reduce((a, r) => a + r.weight, 0);
  const score = totalWeight ? Math.round((scored.reduce((a, r) => a + r.weight * VALUE[r.result], 0) / totalWeight) * 100) : null;
  return { score, results, scoredCount: scored.length };
}

const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].map((x) => String(x).toLowerCase()).sort() : typeof v === "string" ? v.toLowerCase().trim() : (v ?? null));

export default function ComparePage() {
  const { t, lang, tz, me } = useLocaleContext();
  const [params, setParams] = useSearchParams();
  const ids = (params.get("ids") ?? "").split(",").filter(Boolean).slice(0, 4);
  const q = useQuery({ queryKey: ["compare", ids], queryFn: () => api.get<{ items: JobDetail[] }>(`/api/jobs/compare?ids=${ids.join(",")}`), enabled: ids.length >= 2 });
  const setIds = (next: string[]) => setParams(next.length ? { ids: next.join(",") } : {}, { replace: true });
  const prefs = me?.preferences.comparison;
  const hasPrefs = !!prefs && (prefs.preferred_work_modes.length || prefs.preferred_cities.length || prefs.min_salary != null || prefs.preferred_categories.length || prefs.preferred_employment_types.length);
  // Bilingual content: compare in the UI language (AI translations where available, else originals).
  const jobs = (q.data?.items ?? []).map((j) => ({ ...j, posting: localizePosting(j.posting, lang).posting }));

  type RowDef = { key: string; get: (j: JobDetail) => unknown; render: (j: JobDetail) => React.ReactNode; important?: boolean };
  const rows: RowDef[] = [
    { key: "status", get: (j) => j.status, render: (j) => <StatusBadge status={j.status} /> },
    { key: "priority", get: (j) => j.personal.priority, render: (j) => <PriorityBadge priority={j.personal.priority} /> },
    { key: "location", get: (j) => locationText(j.posting), render: (j) => locationText(j.posting) },
    { key: "work_mode", get: (j) => (j.posting.work_mode === "unspecified" ? null : j.posting.work_mode), render: (j) => t(`workMode.${j.posting.work_mode}`) },
    { key: "employment_type", get: (j) => (j.posting.employment_type === "unknown" ? null : j.posting.employment_type), render: (j) => t(`employmentType.${j.posting.employment_type}`) },
    { key: "salary", get: (j) => (j.posting.salary?.min ?? j.posting.salary?.max ? j.posting.salary : null), render: (j) => <SalaryText salary={j.posting.salary} showSource /> },
    { key: "deadline", get: (j) => j.posting.deadline_at, render: (j) => (j.posting.deadline_at ? formatDate(j.posting.deadline_at, lang, tz) : null), important: true },
    { key: "experience", get: (j) => j.posting.years_experience_min ?? j.posting.years_experience_text, render: (j) => (j.posting.years_experience_min != null ? `${j.posting.years_experience_min}+` : j.posting.years_experience_text) },
    { key: "education", get: (j) => j.posting.education_requirements, render: (j) => j.posting.education_requirements?.join("; ") },
    { key: "languages", get: (j) => j.posting.language_requirements, render: (j) => j.posting.language_requirements?.join("; ") },
    { key: "authorization", get: (j) => j.posting.work_authorization, render: (j) => j.posting.work_authorization, important: true },
    { key: "sponsorship", get: (j) => (j.posting.visa_sponsorship === "unknown" ? null : j.posting.visa_sponsorship), render: (j) => t(`visa.${j.posting.visa_sponsorship}`), important: true },
    { key: "benefits", get: (j) => j.posting.benefits, render: (j) => <ul className="list-disc pl-4">{j.posting.benefits?.slice(0, 6).map((b, i) => <li key={i}>{b}</li>)}</ul> },
    { key: "responsibilities", get: (j) => j.posting.responsibilities, render: (j) => <ul className="list-disc pl-4">{j.posting.responsibilities?.slice(0, 6).map((b, i) => <li key={i}>{b}</li>)}</ul> },
  ];
  const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length);

  const skills = jobs.map((j) => new Set([...(j.posting.technical_skills ?? []), ...(j.posting.tools ?? [])].map((s) => s.toLowerCase())));
  const shared = skills.length ? [...skills[0]].filter((s) => skills.every((set) => set.has(s))) : [];

  return (
    <div>
      <PageHeader title={t("compare.title")} subtitle={t("compare.subtitle")} actions={ids.length < 4 ? <AddJobPicker exclude={ids} onAdd={(id) => setIds([...ids, id])} /> : null} />
      {ids.length < 2 ? (
        <Card>
          <EmptyState icon={<GitCompare />} title={t("compare.pick")} body={t("compare.pickHelp")} action={<AddJobPicker exclude={ids} onAdd={(id) => setIds([...ids, id])} />} />
        </Card>
      ) : q.isError ? (
        <ErrorState message={t("common.loadingFailed")} onRetry={() => q.refetch()} retryLabel={t("actions.retry")} />
      ) : q.isLoading ? (
        <Skeleton className="h-96" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] table-fixed text-[13px]">
            <colgroup>
              <col className="w-40" />
              {jobs.map((j) => (
                <col key={j.id} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-line align-top">
                <th />
                {jobs.map((j) => (
                  <th key={j.id} className="px-3 py-3 text-left font-normal">
                    <div className="flex items-start gap-2">
                      <CompanyAvatar name={j.company.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-ink-3">{displayCompany(j.company.name, t)}</p>
                        <Link to={`/jobs/${j.id}`} className="line-clamp-2 font-semibold text-ink hover:underline">
                          {displayTitle(j.posting.title, t)}
                        </Link>
                      </div>
                      <Button variant="ghost" size="icon-sm" aria-label={t("compare.remove")} onClick={() => setIds(ids.filter((x) => x !== j.id))}>
                        <X />
                      </Button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              <tr className="align-top">
                <th scope="row" className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">
                  {t("compare.score")}
                </th>
                {jobs.map((j) => {
                  if (!hasPrefs || !prefs) return <td key={j.id} className="px-3 py-2.5 text-xs text-ink-4">{j === jobs[0] ? <Link to="/settings#preferences" className="text-accent hover:underline">{t("compare.noPrefs")}</Link> : null}</td>;
                  const s = scoreJob(j, prefs);
                  return (
                    <td key={j.id} className="px-3 py-2.5">
                      <Popover>
                        <PopoverTrigger asChild>
                          <button type="button" className="inline-flex items-baseline gap-1 rounded hover:bg-subtle">
                            <span className="text-lg font-semibold tabular">{s.score ?? "—"}</span>
                            {s.score != null ? <span className="text-xs text-ink-4">/100</span> : null}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent>
                          <p className="mb-1 text-xs font-semibold">{t("compare.scoreBreakdown")}</p>
                          <p className="mb-2 text-[11px] text-ink-3">{t("compare.scoreHelp")}</p>
                          <ul className="space-y-1">
                            {s.results.map((r) => (
                              <li key={r.criterion} className="flex items-center justify-between gap-2 text-xs">
                                <span>
                                  {t(`compare.criteria.${r.criterion}`)} <span className="text-ink-4">({t("compare.weight", { w: r.weight })})</span>
                                </span>
                                <Badge tone={r.result === "match" ? "ok" : r.result === "partial" ? "neutral" : r.result === "miss" ? "danger" : "outline"}>{t(`compare.criterionResult.${r.result}`)}</Badge>
                              </li>
                            ))}
                          </ul>
                        </PopoverContent>
                      </Popover>
                    </td>
                  );
                })}
              </tr>
              <tr className="align-top">
                <th scope="row" className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">
                  {t("match.compareRow")}
                </th>
                {jobs.map((j) => (
                  <td key={j.id} className="px-3 py-2.5">
                    <CompareMatch jobId={j.id} />
                  </td>
                ))}
              </tr>
              {rows.map((r) => {
                const values = jobs.map(r.get);
                const nonEmpty = values.filter((v) => !empty(v));
                const allSame = nonEmpty.length === values.length && new Set(values.map(norm)).size === 1;
                return (
                  <tr key={r.key} className="align-top">
                    <th scope="row" className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">
                      {t(`compare.rows.${r.key}`)}
                      {nonEmpty.length > 1 ? <span className={cn("ml-1.5 text-[10px] font-normal", allSame ? "text-ink-4" : "text-info")}>{allSame ? t("compare.same") : t("compare.different")}</span> : null}
                    </th>
                    {jobs.map((j, i) => (
                      <td key={j.id} className={cn("px-3 py-2.5 text-ink-2", !allSame && !empty(values[i]) && nonEmpty.length > 1 && "bg-info-soft/30", r.important && !empty(values[i]) && "font-medium text-ink")}>
                        {empty(values[i]) ? <span className="text-xs text-ink-4">{t("compare.missing")}</span> : r.render(j)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr className="align-top">
                <th scope="row" className="px-3 py-2.5 text-left text-xs font-medium text-ink-3">
                  {t("compare.rows.skills")}
                </th>
                {jobs.map((j, i) => {
                  const unique = [...skills[i]].filter((s) => !shared.includes(s));
                  return (
                    <td key={j.id} className="space-y-2 px-3 py-2.5">
                      {shared.length ? (
                        <div>
                          <p className="mb-1 text-[11px] text-ink-4">{t("compare.sharedRequirements")}</p>
                          <div className="flex flex-wrap gap-1">{shared.map((s) => <Badge key={s} tone="neutral">{s}</Badge>)}</div>
                        </div>
                      ) : null}
                      {unique.length ? (
                        <div>
                          <p className="mb-1 text-[11px] text-ink-4">{t("compare.uniqueRequirements")}</p>
                          <div className="flex flex-wrap gap-1">{unique.map((s) => <Badge key={s} tone="info">{s}</Badge>)}</div>
                        </div>
                      ) : null}
                      {!skills[i].size ? <span className="text-xs text-ink-4">{t("compare.missing")}</span> : null}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function AddJobPicker({ exclude, onAdd }: { exclude: string[]; onAdd: (id: string) => void }) {
  const { t, lang } = useLocaleContext();
  const list = useQuery({ queryKey: ["jobs", "compare-picker"], queryFn: () => api.get<Paginated<JobListItem>>(`/api/jobs${qs({ page_size: 200, sort: "last_activity_at" })}`) });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary">
          <Plus />
          {t("compare.addJob")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <NativeSelect aria-label={t("compare.addJob")} value="" onChange={(e) => e.target.value && onAdd(e.target.value)}>
          <option value="">{t("compare.addJob")}</option>
          {list.data?.items.filter((j) => !exclude.includes(j.id)).map((j) => (
            <option key={j.id} value={j.id}>
              {displayCompany(j.company_name, t)} — {displayTitle(localizedTitle(j, lang), t)}
            </option>
          ))}
        </NativeSelect>
      </PopoverContent>
    </Popover>
  );
}

/** Profile match (qualifications vs. the user's profile) for one compared job. */
function CompareMatch({ jobId }: { jobId: string }) {
  const { t } = useLocaleContext();
  const m = useMatch(jobId).data?.summary;
  if (!m) return null;
  if (!m.has_profile) return <Link to="/profile" className="text-xs text-accent hover:underline">{t("match.setUpProfile")}</Link>;
  return (
    <Link to={`/jobs/${jobId}?tab=match`} className="flex flex-col items-start gap-0.5 hover:underline">
      <MatchLevelBadge level={m.level} score={m.score} />
      <span className="text-[11px] text-ink-4">{t("match.mustHavesShort", { met: m.mandatory.met, total: m.mandatory.total })}</span>
    </Link>
  );
}
