import { LIMITS } from "@shared/constants";
import type { DuplicateMatch } from "@shared/types";
import { useMutation } from "@tanstack/react-query";
import { AiImportForm } from "./ai-import";
import { AiOptIn } from "./ai-opt-in";
import { AlertTriangle, ExternalLink, Link2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/tabs";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs } from "@/hooks/useJobMutations";
import { api, ApiRequestError } from "@/lib/api";
import { StatusBadge } from "./badges";
import { ExtractionFallback, ExtractionProgress, isTerminal, useExtraction } from "./extraction-progress";
import { ExtractionReview } from "./extraction-review";
import { JobForm, type JobFormSubmit } from "./job-form";

type Tab = "url" | "paste" | "manual" | "ai";
type Pending = { kind: "capture"; body: { url?: string; text?: string; use_ai?: boolean } } | { kind: "manual"; body: JobFormSubmit };

function validUrl(v: string) {
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function QuickAddDialog({ open, onOpenChange, initialUrl, initialTab, autoSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; initialUrl?: string; initialTab?: Tab; autoSubmit?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const onError = useToastError();
  const invalidate = useInvalidateJobs();
  const [tab, setTab] = React.useState<Tab>("url");
  const [url, setUrl] = React.useState("");
  const [text, setText] = React.useState("");
  const [pasteUrl, setPasteUrl] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [dups, setDups] = React.useState<{ matches: DuplicateMatch[]; pending: Pending } | null>(null);
  const [captured, setCaptured] = React.useState<{ savedJobId: string; extractionId: string } | null>(null);
  const [useAi, setUseAi] = React.useState(false);
  const extraction = useExtraction(captured?.extractionId);

  React.useEffect(() => {
    if (open) {
      setTab(initialTab ?? "url");
      setUrl(initialUrl ?? "");
      setText("");
      setPasteUrl("");
      setTouched(false);
      setDups(null);
      setCaptured(null);
    }
  }, [open, initialUrl, initialTab]);

  const capture = useMutation({
    mutationFn: (body: { url?: string; text?: string; confirm_duplicate?: boolean; use_ai?: boolean }) => api.post<{ saved_job_id: string; extraction_id: string }>("/api/jobs/capture", body),
    onSuccess: (r) => {
      setDups(null);
      setCaptured({ savedJobId: r.saved_job_id, extractionId: r.extraction_id });
      toast.success(t("quickAdd.savedExtracting"));
      void invalidate();
    },
    onError: (e, body) => {
      if (e instanceof ApiRequestError && e.code === "possible_duplicate") {
        setDups({ matches: (e.details as { matches: DuplicateMatch[] }).matches, pending: { kind: "capture", body } });
      } else onError(e);
    },
  });
  const manual = useMutation({
    mutationFn: (body: JobFormSubmit & { confirm_duplicate?: boolean }) => api.post<{ id: string }>("/api/jobs", body),
    onSuccess: (r) => {
      toast.success(t("jobForm.created"));
      void invalidate();
      onOpenChange(false);
      navigate(`/jobs/${r.id}`);
    },
    onError: (e, body) => {
      if (e instanceof ApiRequestError && e.code === "possible_duplicate") setDups({ matches: (e.details as { matches: DuplicateMatch[] }).matches, pending: { kind: "manual", body } });
      else onError(e);
    },
  });

  // Submitted straight from the dashboard paste box: capture immediately (once).
  const autoSubmitted = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (open && autoSubmit && initialUrl && validUrl(initialUrl) && autoSubmitted.current !== initialUrl) {
      autoSubmitted.current = initialUrl;
      capture.mutate({ url: initialUrl.trim() });
    }
    if (!open) autoSubmitted.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoSubmit, initialUrl]);

  const urlError = touched && url && !validUrl(url) ? t("quickAdd.invalidUrl") : undefined;
  const ex = extraction.data;
  const busy = capture.isPending || manual.isPending;

  let body: React.ReactNode;
  if (dups) {
    body = (
      <div className="space-y-4">
        <div className="flex gap-2.5 rounded-lg bg-warn-soft px-3 py-2.5 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{t("quickAdd.duplicateTitle")}</p>
            <p className="text-xs">{t("quickAdd.duplicateBody")}</p>
          </div>
        </div>
        <ul className="divide-y divide-line rounded-lg border border-line">
          {dups.matches.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {m.company_name} — {m.title || t("common.untitledJob")}
                </p>
                <p className="text-xs text-ink-3">{t(`quickAdd.duplicateReason.${m.reason}`, { platform: "" })}</p>
              </div>
              <StatusBadge status={m.status} />
              <Button variant="secondary" size="sm" asChild>
                <Link to={`/jobs/${m.id}`} onClick={() => onOpenChange(false)}>
                  {t("quickAdd.viewExisting")}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDups(null)}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => (dups.pending.kind === "capture" ? capture.mutate({ ...dups.pending.body, confirm_duplicate: true }) : manual.mutate({ ...dups.pending.body, confirm_duplicate: true }))}
          >
            {t("quickAdd.saveAnyway")}
          </Button>
        </div>
      </div>
    );
  } else if (captured) {
    body = !ex ? (
      <Spinner label={t("app.loading")} />
    ) : !isTerminal(ex.status) ? (
      <div className="space-y-4">
        <ExtractionProgress extraction={ex} />
        <p className="text-xs text-ink-4">{t("quickAdd.keepWorking")}</p>
        <div className="flex justify-end">
          <Button variant="secondary" asChild>
            <Link to={`/jobs/${captured.savedJobId}`} onClick={() => onOpenChange(false)}>
              {t("actions.viewJob")}
            </Link>
          </Button>
        </div>
      </div>
    ) : ex.result && (ex.status === "succeeded" || ex.status === "partial" || ex.status === "needs_review") ? (
      <div className="space-y-3">
        {ex.error_code ? <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">{t(`extraction.errors.${ex.error_code}`, { defaultValue: ex.error_message ?? "" })}</p> : null}
        <ExtractionReview
          extraction={ex}
          onApplied={(id) => {
            onOpenChange(false);
            navigate(`/jobs/${id}`);
          }}
          onDismiss={() => {
            onOpenChange(false);
            navigate(`/jobs/${captured.savedJobId}`);
          }}
        />
      </div>
    ) : (
      <ExtractionFallback extraction={ex} onNewExtraction={(id) => setCaptured((c) => (c ? { ...c, extractionId: id } : c))} />
    );
  } else {
    body = (
      <div className="space-y-4">
        <Segmented
          label={t("quickAdd.title")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "url", label: t("quickAdd.tabUrl") },
            { value: "paste", label: t("quickAdd.tabPaste") },
            { value: "manual", label: t("quickAdd.tabManual") },
            { value: "ai", label: t("drafts.import.tab") },
          ]}
        />
        {tab === "url" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (validUrl(url)) capture.mutate({ url: url.trim(), use_ai: useAi || undefined });
            }}
          >
            <Field label={t("quickAdd.urlLabel")} htmlFor="qa-url" error={urlError} hint={t("quickAdd.urlHelp")}>
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-4" />
                <Input id="qa-url" autoFocus type="url" inputMode="url" className="h-9 pl-8" placeholder={t("quickAdd.urlPlaceholder")} value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={!!urlError} maxLength={LIMITS.urlMaxLength} />
              </div>
            </Field>
            <AiOptIn id="qa-ai-url" checked={useAi} onChange={setUseAi} />
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={!url || busy}>
                {busy ? t("actions.saving") : t("quickAdd.saveAndExtract")}
              </Button>
            </div>
          </form>
        ) : tab === "paste" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (text.trim().length >= 40 && (!pasteUrl || validUrl(pasteUrl))) capture.mutate({ text, url: pasteUrl.trim() || undefined, use_ai: useAi || undefined });
            }}
          >
            <Field label={t("quickAdd.pasteLabel")} htmlFor="qa-text" error={touched && text.trim().length < 40 ? t("quickAdd.tooShort") : undefined}>
              <Textarea id="qa-text" autoFocus rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("quickAdd.pastePlaceholder")} maxLength={LIMITS.jdMaxChars} />
            </Field>
            <Field label={t("quickAdd.pasteUrlLabel")} htmlFor="qa-paste-url" error={touched && pasteUrl && !validUrl(pasteUrl) ? t("quickAdd.invalidUrl") : undefined}>
              <Input id="qa-paste-url" type="url" placeholder="https://" value={pasteUrl} onChange={(e) => setPasteUrl(e.target.value)} />
            </Field>
            <AiOptIn id="qa-ai-paste" checked={useAi} onChange={setUseAi} />
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t("actions.saving") : t("quickAdd.saveAndExtract")}
              </Button>
            </div>
          </form>
        ) : tab === "ai" ? (
          <AiImportForm
            onCreated={(id) => {
              onOpenChange(false);
              navigate(`/drafts/${id}`);
            }}
          />
        ) : (
          <JobForm mode="create" busy={busy} onSubmit={(v) => manual.mutate(v)} />
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={captured && ex && isTerminal(ex.status) && ex.result ? t("extraction.review.title") : t("quickAdd.title")}
        size={tab === "manual" || (captured && ex?.result) ? "xl" : "lg"}
        onPointerDownOutside={(e) => (captured || tab !== "url" ? e.preventDefault() : undefined)}
      >
        {body}
        {captured && ex?.input_url ? (
          <a href={ex.input_url} target="_blank" rel="noopener noreferrer nofollow" className="mt-4 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
            <ExternalLink className="size-3" />
            <span className="max-w-[60ch] truncate">{ex.input_url}</span>
          </a>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
