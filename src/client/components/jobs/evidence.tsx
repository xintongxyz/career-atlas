import type { EvidenceDTO, OverrideDTO } from "@shared/types";
import { CircleCheck, Info, PencilLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlay";
import { useLocaleContext } from "@/hooks/useMe";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Info button showing where a field value came from (source, confidence, verbatim quote). */
export function EvidencePopover({ evidence, override, onConfirm, className }: { evidence?: EvidenceDTO; override?: OverrideDTO; onConfirm?: () => void; className?: string }) {
  const { t } = useTranslation();
  const { lang, tz } = useLocaleContext();
  if (!evidence && !override) return null;
  const needsReview = evidence?.review_status === "needs_review";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("extraction.evidenceTitle")}
          className={cn("inline-flex size-5 items-center justify-center rounded text-ink-4 hover:bg-subtle hover:text-ink-2", needsReview && "text-warn", className)}
        >
          {override ? <PencilLine className="size-3.5" /> : <Info className="size-3.5" />}
          {needsReview ? <span className="sr-only">{t("extraction.review.needsReview")}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <p className="mb-2 text-xs font-semibold text-ink">{t("extraction.evidenceTitle")}</p>
        {evidence ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="outline">{t("extraction.evidenceFrom", { source: t(`extraction.source.${evidence.source}`) })}</Badge>
              <Badge tone={evidence.confidence === "high" ? "ok" : evidence.confidence === "medium" ? "neutral" : "warn"}>{t(`extraction.confidence.${evidence.confidence}`)}</Badge>
              {needsReview ? <Badge tone="warn">{t("extraction.review.needsReview")}</Badge> : null}
            </div>
            {evidence.evidence ? (
              <blockquote className="rounded-md border-l-2 border-accent/50 bg-subtle px-2.5 py-1.5 text-xs leading-relaxed text-ink-2" lang="">
                “{evidence.evidence}”
              </blockquote>
            ) : (
              <p className="text-xs text-ink-3">{t("extraction.review.noEvidence")}</p>
            )}
            <p className="text-[11px] text-ink-4">{formatDateTime(evidence.extracted_at, lang, tz)}</p>
          </div>
        ) : null}
        {override ? (
          <div className="mt-2 border-t border-line pt-2 text-xs text-ink-3">
            <p className="font-medium text-ink-2">{t("extraction.review.manualEdit")}</p>
            <p className="mt-0.5 break-words">{t("extraction.originalValue", { value: formatValue(override.original_value) })}</p>
          </div>
        ) : null}
        {needsReview && onConfirm ? (
          <button type="button" onClick={onConfirm} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
            <CircleCheck className="size-3.5" />
            {t("extraction.confirmField")}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function formatValue(v: unknown): string {
  if (v == null || v === "") return "—";
  if (Array.isArray(v)) return v.join("; ");
  if (typeof v === "object") {
    const s = v as { min?: number | null; max?: number | null; currency?: string | null; period?: string };
    if ("min" in s || "max" in s) return [s.min, s.max].filter((x) => x != null).join("–") + (s.currency ? ` ${s.currency}` : "") + (s.period && s.period !== "unknown" ? ` / ${s.period}` : "");
    return JSON.stringify(v);
  }
  return String(v);
}
