// "My match" for one job: requirements vs. the user's profile, computed locally.
// Mandatory eligibility gaps are shown first and are never folded into the score.
import type { MatchItem, MatchResult, RequirementCategory } from "@shared/match";
import type { JobDetail } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleHelp, UserRound, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Badge, EmptyState, Skeleton } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function useMatch(jobId: string) {
  return useQuery({ queryKey: ["match", jobId], queryFn: () => api.get<MatchResult>(`/api/jobs/${jobId}/match`) });
}

/** Reason text with enum parameters (e.g. language level) shown in the UI language. */
export function useReasonText() {
  const { t } = useTranslation();
  return (r: MatchItem["reason"]) => {
    const params = { ...(r.params ?? {}) };
    if (typeof params.level === "string") params.level = t(`profile.languageLevel.${params.level}`);
    return t(`match.reasons.${r.code}`, params);
  };
}

const ICON = { met: CheckCircle2, partial: CircleDashed, not_met: XCircle, unknown: CircleHelp } as const;
const TONE = { met: "text-ok", partial: "text-warn", not_met: "text-danger", unknown: "text-ink-4" } as const;

export function MatchLevelBadge({ level, score }: { level: MatchResult["summary"]["level"]; score: number | null }) {
  const { t } = useTranslation();
  const tone = level === "mandatory_gap" ? "danger" : level === "strong" || level === "good" ? "ok" : level === "insufficient" ? "neutral" : "warn";
  return (
    <Badge tone={tone}>
      {t(`match.level.${level}`)}
      {score != null ? ` · ${score}` : ""}
    </Badge>
  );
}

export function MatchPanel({ job }: { job: JobDetail }) {
  const { t } = useTranslation();
  const reasonText = useReasonText();
  const q = useMatch(job.id);
  if (q.isPending) return <Skeleton className="h-64" />;
  if (!q.data) return null;
  const { summary, items } = q.data;
  if (!summary.has_profile) {
    return (
      <EmptyState
        icon={<UserRound />}
        title={t("match.noProfileTitle")}
        body={t("match.noProfileBody")}
        action={
          <Link to="/profile" className="text-[13px] font-medium text-accent underline">
            {t("match.setUpProfile")}
          </Link>
        }
      />
    );
  }
  if (!items.length) return <p className="text-[13px] text-ink-3">{t("match.noRequirements")}</p>;

  // Requirement wording as currently displayed on the job page (AI translation or original).
  const display = (it: MatchItem) => {
    const v = (job.posting as unknown as Record<string, unknown>)[it.field];
    if (Array.isArray(v) && it.index != null && typeof v[it.index] === "string") return v[it.index] as string;
    if (typeof v === "string" && it.index == null && v.trim()) return v;
    return it.text;
  };
  const blockers = items.filter((i) => i.eligibility && i.status === "not_met");
  const group = (cat: RequirementCategory) => items.filter((i) => i.category === cat);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-subtle/50 px-4 py-3 text-[13px]">
        <MatchLevelBadge level={summary.level} score={null} />
        <span>{t("match.mustHaves", { met: summary.mandatory.met, total: summary.mandatory.total })}</span>
        {summary.mandatory.not_met ? <span className="text-danger">{t("match.notMetCount", { count: summary.mandatory.not_met })}</span> : null}
        {summary.mandatory.partial ? <span className="text-warn">{t("match.partialCount", { count: summary.mandatory.partial })}</span> : null}
        {summary.mandatory.unknown ? <span className="text-ink-3">{t("match.unknownCount", { count: summary.mandatory.unknown })}</span> : null}
        <span>{t("match.preferredLine", { met: summary.preferred.met, total: summary.preferred.total })}</span>
        <span className="text-ink-3">{summary.score != null ? t("match.score", { score: summary.score }) : t("match.scoreUnavailable")}</span>
      </div>

      {blockers.length ? (
        <section className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-danger">
            <AlertTriangle className="size-4" />
            {t("match.blockersTitle", { count: blockers.length })}
          </p>
          <ul className="space-y-1 text-[13px] text-ink">
            {blockers.map((b) => (
              <li key={b.id}>
                <span className="font-medium">{display(b)}</span> — {reasonText(b.reason)}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-ink-3">{t("match.blockersNote")}</p>
        </section>
      ) : null}

      {(["mandatory", "preferred", "unclear"] as const).map((cat) =>
        group(cat).length ? (
          <section key={cat} className="space-y-1.5">
            <h3 className="text-[13px] font-semibold text-ink">{t(`match.groups.${cat}`)}</h3>
            {cat === "unclear" ? <p className="text-xs text-ink-4">{t("match.unclearHelp")}</p> : null}
            <ul className="divide-y divide-line rounded-lg border border-line">
              {group(cat).map((it) => {
                const Icon = ICON[it.status];
                return (
                  <li key={it.id} className="flex items-start gap-2.5 px-3 py-2 text-[13px]" data-status={it.status}>
                    <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[it.status])} aria-label={t(`match.status.${it.status}`)} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-ink" title={display(it) !== it.text ? it.text : undefined}>
                        {display(it)}
                        {it.ai_inferred ? <Badge tone="warn" className="ml-1.5">{t("match.aiInferred")}</Badge> : null}
                        {it.flexible ? <Badge tone="outline" className="ml-1.5">{t("match.flexible")}</Badge> : null}
                      </p>
                      <p className={cn("text-xs", TONE[it.status] === "text-ink-4" ? "text-ink-3" : TONE[it.status])}>{reasonText(it.reason)}</p>
                      {it.profile_evidence ? (
                        <p className="text-xs text-ink-4">
                          {t("match.fromProfile")}: {it.profile_evidence}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null,
      )}
      <p className="text-xs text-ink-4">{t("match.footer")}</p>
    </div>
  );
}
