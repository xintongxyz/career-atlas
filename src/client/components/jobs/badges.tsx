import type { ExtractionStatus, PipelineStatus, Priority } from "@shared/constants";
import type { Salary } from "@shared/schemas";
import { AlertCircle, ArrowDown, ArrowUp, Building2, Equal, Loader2, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/misc";
import { useLocaleContext } from "@/hooks/useMe";
import { formatSalary } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<PipelineStatus, Parameters<typeof Badge>[0]["tone"]> = {
  saved: "neutral",
  preparing: "info",
  applied: "accent",
  awaiting_response: "accent",
  assessment: "violet",
  interview: "violet",
  offer: "ok",
  accepted: "ok",
  rejected: "danger",
  withdrawn: "neutral",
  closed: "neutral",
  archived: "outline",
};

export const STATUS_DOT: Record<PipelineStatus, string> = {
  saved: "bg-ink-4",
  preparing: "bg-info",
  applied: "bg-accent",
  awaiting_response: "bg-accent/60",
  assessment: "bg-violet/70",
  interview: "bg-violet",
  offer: "bg-ok",
  accepted: "bg-ok",
  rejected: "bg-danger/70",
  withdrawn: "bg-ink-4",
  closed: "bg-ink-4",
  archived: "bg-line-strong",
};

export function StatusBadge({ status, className }: { status: PipelineStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      {t(`status.${status}`)}
    </Badge>
  );
}

export function PriorityBadge({ priority, compact }: { priority: Priority | null; compact?: boolean }) {
  const { t } = useTranslation();
  if (!priority) return null;
  const Icon = priority === "high" ? ArrowUp : priority === "low" ? ArrowDown : Equal;
  const tone = priority === "high" ? "text-warn" : priority === "low" ? "text-ink-4" : "text-ink-3";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", tone)} title={`${t("priority.label")}: ${t(`priority.${priority}`)}`}>
      <Icon className="size-3" aria-hidden />
      {compact ? <span className="sr-only">{t(`priority.${priority}`)}</span> : t(`priority.${priority}`)}
    </span>
  );
}

export function WorkModeBadge({ mode }: { mode: string }) {
  const { t } = useTranslation();
  if (!mode || mode === "unspecified") return null;
  return <Badge tone="outline">{t(`workMode.${mode}`)}</Badge>;
}

export function StarMark({ starred }: { starred: boolean }) {
  const { t } = useTranslation();
  if (!starred) return null;
  return <Star className="size-3.5 fill-warn text-warn" aria-label={t("fields.is_starred")} />;
}

export function CompanyAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials = (name || "?")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join("")
    .toUpperCase();
  // Stable, muted hue per company.
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const dims = { sm: "size-6 text-[10px]", md: "size-8 text-xs", lg: "size-11 text-sm" }[size];
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-md font-semibold", dims)} style={{ background: `hsl(${h} 25% 92%)`, color: `hsl(${h} 30% 32%)` }}>
      {initials || <Building2 className="size-3.5" />}
    </span>
  );
}

export function SalaryText({ salary, className, showSource }: { salary: Salary | null | undefined; className?: string; showSource?: boolean }) {
  const { t, lang } = useLocaleContext();
  const disclosed = salary && (salary.min != null || salary.max != null);
  return (
    <span className={cn("tabular", !disclosed && "text-ink-4", className)}>
      {formatSalary(salary ?? null, t, lang)}
      {showSource && disclosed && salary!.source !== "employer" ? <span className="ml-1 text-[11px] text-warn">({t(`salary.source.${salary!.source}`)})</span> : null}
    </span>
  );
}

export function ExtractionBadge({ status }: { status: ExtractionStatus }) {
  const { t } = useTranslation();
  if (status === "none" || status === "succeeded") return null;
  const running = status === "queued" || status === "fetching" || status === "extracting";
  const tone = running ? "info" : status === "failed" || status === "access_restricted" ? "warn" : "warn";
  return (
    <Badge tone={tone}>
      {running ? <Loader2 className="animate-spin" /> : <AlertCircle />}
      {t(`extraction.status.${status}`)}
    </Badge>
  );
}

export function displayTitle(title: string | null | undefined, t: (k: string) => string) {
  return title?.trim() ? title : t("common.untitledJob");
}
export function displayCompany(name: string | null | undefined, t: (k: string) => string) {
  return !name || name === "Unknown company" ? t("common.unknownCompany") : name;
}
