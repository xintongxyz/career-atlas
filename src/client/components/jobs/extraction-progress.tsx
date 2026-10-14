import { EXTRACTION_TERMINAL, LIMITS } from "@shared/constants";
import type { ExtractionDTO } from "@shared/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, CircleDashed, Loader2, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldHint, Label, Textarea } from "@/components/ui/input";
import { useToastError } from "@/hooks/useApiError";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function isTerminal(status: string) {
  return (EXTRACTION_TERMINAL as readonly string[]).includes(status);
}

/** Polls an extraction until it reaches a terminal state (server marks stale jobs as failed). */
export function useExtraction(id: string | null | undefined) {
  return useQuery({
    queryKey: ["extraction", id],
    queryFn: () => api.get<ExtractionDTO>(`/api/extractions/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : 1200),
  });
}

const STEPS = ["queued", "fetching", "extracting"] as const;

export function ExtractionProgress({ extraction }: { extraction: ExtractionDTO }) {
  const { t } = useTranslation();
  const idx = STEPS.indexOf(extraction.status as (typeof STEPS)[number]);
  return (
    <div className="space-y-3" aria-live="polite">
      <ol className="space-y-2">
        {STEPS.map((s, i) => {
          const done = idx > i || isTerminal(extraction.status);
          const active = idx === i;
          return (
            <li key={s} className={cn("flex items-center gap-2 text-[13px]", done ? "text-ink-2" : active ? "text-ink" : "text-ink-4")}>
              {done ? <CheckCircle2 className="size-4 text-ok" /> : active ? <Loader2 className="size-4 animate-spin text-accent" /> : <CircleDashed className="size-4" />}
              <span className={cn(active && "font-medium")}>{t(`extraction.status.${s}`)}</span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-ink-3">{t(`extraction.statusHelp.${extraction.status}`, { defaultValue: "" })}</p>
      {extraction.error_message && extraction.status === "queued" ? <p className="text-xs text-warn">{extraction.error_message}</p> : null}
    </div>
  );
}

/** Shown when automatic extraction is restricted or failed: explains why and offers paste / retry. */
export function ExtractionFallback({ extraction, onNewExtraction }: { extraction: ExtractionDTO; onNewExtraction: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const onError = useToastError();
  const [text, setText] = React.useState("");
  const code = extraction.error_code ?? "internal_error";
  const message = i18n.exists(`extraction.errors.${code}`) ? t(`extraction.errors.${code}`) : t(`extraction.statusHelp.${extraction.status}`);
  const paste = useMutation({
    mutationFn: () => api.post<{ extraction_id: string }>(`/api/jobs/${extraction.saved_job_id}/extract-text`, { text }),
    onSuccess: (r) => onNewExtraction(r.extraction_id),
    onError,
  });
  const retry = useMutation({
    mutationFn: () => api.post<{ extraction_id: string }>(`/api/extractions/${extraction.id}/retry`),
    onSuccess: (r) => onNewExtraction(r.extraction_id),
    onError,
  });
  const restricted = extraction.status === "access_restricted";
  const canRetry = extraction.input_type === "url" && !restricted && code !== "blocked_destination" && code !== "invalid_url";
  return (
    <div className="space-y-4">
      <div className={cn("flex gap-2.5 rounded-lg px-3 py-2.5 text-[13px]", restricted ? "bg-info-soft text-info" : "bg-warn-soft text-warn")}>
        {restricted ? <ShieldAlert className="mt-0.5 size-4 shrink-0" /> : <AlertCircle className="mt-0.5 size-4 shrink-0" />}
        <div>
          <p className="font-medium">{t(`extraction.status.${extraction.status}`)}</p>
          <p className="mt-0.5 text-xs opacity-90">{message}</p>
        </div>
      </div>
      {extraction.saved_job_id ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            paste.mutate();
          }}
        >
          <Label htmlFor="fallback-text">{t("extraction.pasteFallback")}</Label>
          <Textarea id="fallback-text" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("quickAdd.pastePlaceholder")} maxLength={LIMITS.jdMaxChars} />
          <FieldHint>{t("extraction.pasteFallbackHelp")}</FieldHint>
          <div className="flex justify-end gap-2">
            {canRetry ? (
              <Button variant="ghost" onClick={() => retry.mutate()} disabled={retry.isPending}>
                {t("actions.retry")}
              </Button>
            ) : null}
            <Button type="submit" variant="primary" disabled={text.trim().length < 40 || paste.isPending}>
              {t("quickAdd.saveAndExtract")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
