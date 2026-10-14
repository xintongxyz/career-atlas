import type { JobDetail } from "@shared/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ChevronLeft, ExternalLink, Loader2, MoreHorizontal, Pencil, RotateCcw, Sparkles, Star, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { CompanyAvatar, PriorityBadge, displayCompany, displayTitle } from "@/components/jobs/badges";
import { useDetailCtx } from "@/components/jobs/detail-parts";
import { ActivityTab, ApplicationTab, DetailSidebar, NotesTab, OriginalTab, OverviewTab, RequirementsTab } from "@/components/jobs/detail-tabs";
import { ExtractionFallback, ExtractionProgress, isTerminal, useExtraction } from "@/components/jobs/extraction-progress";
import { ExtractionReview } from "@/components/jobs/extraction-review";
import { JobForm } from "@/components/jobs/job-form";
import { DeleteJobDialog } from "@/components/jobs/delete-job-dialog";
import { StatusControl } from "@/components/jobs/status-control";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Badge, ErrorState, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs, useStatusMutation } from "@/hooks/useJobMutations";
import { useLocaleContext } from "@/hooks/useMe";
import { api, ApiRequestError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { hasTranslation, localizePosting } from "@/lib/job-i18n";
import { NotFound } from "./system";
import { useAiOnRequest } from "@/components/jobs/ai-opt-in";

const TABS = ["overview", "requirements", "original", "application", "activity", "notes"] as const;

export default function JobDetailPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["job", id], queryFn: () => api.get<JobDetail>(`/api/jobs/${id}`) });
  if (q.isError && q.error instanceof ApiRequestError && q.error.status === 404) return <NotFound />;
  if (q.isError) return <ErrorState message={t("common.loadingFailed")} onRetry={() => q.refetch()} retryLabel={t("actions.retry")} />;
  if (!q.data)
    return (
      <div className="space-y-4">
        <Skeleton className="h-16" />
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  return <JobDetailView job={q.data} />;
}

function JobDetailView({ job }: { job: JobDetail }) {
  const { t, lang, tz } = useLocaleContext();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? params.get("tab")! : "overview";
  // Bilingual content: show the AI translation for the UI language (toggle back to the original).
  const [showOriginal, setShowOriginal] = React.useState(false);
  const local = React.useMemo(() => (showOriginal ? { posting: job.posting, translated: [] as string[] } : localizePosting(job.posting, lang)), [job.posting, lang, showOriginal]);
  const shownJob = React.useMemo(() => ({ ...job, posting: local.posting }), [job, local.posting]);
  const ctx = useDetailCtx(shownJob, local.translated);
  const invalidate = useInvalidateJobs();
  const onError = useToastError();
  const status = useStatusMutation();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [extractionId, setExtractionId] = React.useState<string | null>(job.latest_extraction?.id ?? null);
  React.useEffect(() => setExtractionId(job.latest_extraction?.id ?? null), [job.latest_extraction?.id]);

  const extraction = useExtraction(extractionId);
  const ex = extraction.data;
  const pendingReview = ex && isTerminal(ex.status) && ex.result && !ex.applied_at && !ex.dismissed_at && ["succeeded", "partial", "needs_review"].includes(ex.status);
  const running = ex && !isTerminal(ex.status);
  const failed = ex && !ex.applied_at && !ex.dismissed_at && (ex.status === "failed" || ex.status === "access_restricted") && !ex.result?.fields.posting_status;
  const prevRunning = React.useRef(running);
  React.useEffect(() => {
    if (prevRunning.current && !running) void invalidate();
    prevRunning.current = running;
  }, [running, invalidate]);

  const aiOnRequest = useAiOnRequest();
  const refresh = useMutation({
    mutationFn: (useAi?: boolean) => api.post<{ extraction_id: string }>(`/api/jobs/${job.id}/refresh`, useAi ? { use_ai: true } : undefined),
    onSuccess: (r) => {
      toast(t("job.refreshStarted"));
      setExtractionId(r.extraction_id);
    },
    onError,
  });
  const update = useMutation({
    mutationFn: (body: unknown) => api.patch(`/api/jobs/${job.id}`, body),
    onSuccess: () => {
      toast.success(t("jobForm.updated"));
      setEditing(false);
      void invalidate();
    },
    onError,
  });
  const star = useMutation({ mutationFn: () => api.patch(`/api/jobs/${job.id}`, { personal: { is_starred: !job.personal.is_starred } }), onSuccess: () => invalidate(), onError });

  const p = job.posting;
  const archived = job.status === "archived";
  const reviewCount = job.evidence.filter((e) => e.review_status === "needs_review").length;

  return (
    <div className="space-y-4">
      <button type="button" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/positions"))} className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
        <ChevronLeft className="size-3.5" />
        {t("actions.back")}
      </button>

      {/* Header */}
      <header className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 shadow-card sm:flex-row sm:items-start">
        <CompanyAvatar name={job.company.name} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink-3">{displayCompany(job.company.name, t)}</p>
          <h1 className="mt-0.5 flex items-center gap-2 text-lg font-semibold leading-snug tracking-tight text-ink sm:text-xl">
            {displayTitle(local.posting.title, t)}
            <button type="button" onClick={() => star.mutate()} aria-pressed={job.personal.is_starred} aria-label={job.personal.is_starred ? t("actions.unstar") : t("actions.star")} className="rounded p-0.5 text-ink-4 hover:text-warn">
              <Star className={job.personal.is_starred ? "size-4 fill-warn text-warn" : "size-4"} />
            </button>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-3">
            <StatusControl jobId={job.id} status={job.status} hasApplication={!!job.application} size="sm" />
            <PriorityBadge priority={job.personal.priority} />
            <span>{t("common.savedOn", { date: formatDate(job.personal.saved_at, lang, tz) })}</span>
            {job.application ? <span>{t("common.appliedOn", { date: formatDate(job.application.applied_at, lang, tz) })}</span> : <Badge tone="outline">{t("job.notApplied")}</Badge>}
            {p.posting_status === "closed" ? <Badge tone="neutral">{t("postingStatus.closed")}</Badge> : null}
            {reviewCount ? <Badge tone="warn">{t("extraction.pendingReview", { count: reviewCount })}</Badge> : null}
          </div>
          {hasTranslation(job.posting, lang) ? (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
              <Badge tone="violet">{showOriginal ? t("bilingual.showingOriginal") : t("bilingual.showingTranslation")}</Badge>
              <span>{t("bilingual.originalLanguage", { language: t(`bilingual.languages.${(p.content_language ?? "").split("-")[0]}`, { defaultValue: p.content_language ?? "?" }) })}</span>
              <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setShowOriginal((v) => !v)}>
                {showOriginal ? t("bilingual.showTranslation") : t("bilingual.showOriginal")}
              </button>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.original_url ? (
            <Button asChild variant="secondary">
              <a href={p.apply_url || p.original_url} target="_blank" rel="noopener noreferrer nofollow">
                <ExternalLink />
                {t("actions.openOriginal")}
              </a>
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => setEditing(true)}>
            <Pencil />
            {t("actions.edit")}
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("nav.more")}>
                <MoreHorizontal />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem disabled={!p.original_url || refresh.isPending} onSelect={() => refresh.mutate(false)}>
                <RotateCcw />
                {t("actions.refresh")}
              </MenuItem>
              {aiOnRequest ? (
                <MenuItem disabled={!p.original_url || refresh.isPending} onSelect={() => refresh.mutate(true)} title={t("ai.optInHelp")}>
                  <Sparkles />
                  {t("ai.refreshWithAi")}
                </MenuItem>
              ) : null}
              {archived ? (
                <MenuItem onSelect={() => status.mutate({ id: job.id, status: (job.application?.status ?? job.personal.stage) as never })}>
                  <ArchiveRestore />
                  {t("actions.restore")}
                </MenuItem>
              ) : (
                <MenuItem onSelect={() => status.mutate({ id: job.id, status: "archived" })}>
                  <Archive />
                  {t("actions.archive")}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem destructive onSelect={() => setDeleting(true)}>
                <Trash2 />
                {t("job.deletePermanently")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </header>

      {archived ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2 text-[13px] text-ink-2">
          <Archive className="size-4" />
          <span className="flex-1">{t("job.archivedBanner")}</span>
          <Button size="sm" onClick={() => status.mutate({ id: job.id, status: (job.application?.status ?? job.personal.stage) as never })}>
            <ArchiveRestore />
            {t("actions.restore")}
          </Button>
        </div>
      ) : null}

      {/* Extraction state banner */}
      {running ? (
        <div className="flex items-center gap-2 rounded-lg border border-info/20 bg-info-soft px-3 py-2 text-[13px] text-info" aria-live="polite">
          <Loader2 className="size-4 animate-spin" />
          <span className="flex-1">{t("extraction.banner.running")}</span>
          <span className="text-xs">{t(`extraction.status.${ex!.status}`)}</span>
        </div>
      ) : pendingReview ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2 text-[13px] text-accent">
          <Sparkles className="size-4" />
          <span className="flex-1">{ex!.purpose === "refresh" ? t("extraction.review.refreshTitle") : t("extraction.banner.ready")}</span>
          <Button size="sm" variant="primary" onClick={() => setReviewOpen(true)}>
            {t("actions.review")}
          </Button>
        </div>
      ) : failed ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <span className="flex-1">{ex!.status === "access_restricted" ? t("extraction.banner.restricted") : t("extraction.banner.failed")}</span>
          <Button size="sm" onClick={() => setReviewOpen(true)}>
            {t("extraction.pasteFallback")}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 rounded-xl border border-line bg-surface shadow-card">
          <Tabs value={tab} onValueChange={(v) => setParams((prev) => { const n = new URLSearchParams(prev); n.set("tab", v); return n; }, { replace: true })}>
            <TabsList className="px-3">
              {TABS.map((k) => (
                <TabsTrigger key={k} value={k}>
                  {t(`job.tabs.${k}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="p-4 sm:p-5">
              <TabsContent value="overview">
                <OverviewTab ctx={ctx} />
              </TabsContent>
              <TabsContent value="requirements">
                <RequirementsTab ctx={ctx} />
              </TabsContent>
              <TabsContent value="original">
                <OriginalTab ctx={ctx} onExtract={setExtractionId} />
              </TabsContent>
              <TabsContent value="application">
                <ApplicationTab ctx={ctx} />
              </TabsContent>
              <TabsContent value="activity">
                <ActivityTab ctx={ctx} />
              </TabsContent>
              <TabsContent value="notes">
                <NotesTab jobId={job.id} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
        <DetailSidebar ctx={ctx} onRefresh={() => refresh.mutate()} />
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent title={t("jobForm.editTitle")} size="xl">
          <JobForm mode="edit" initial={p} busy={update.isPending} onCancel={() => setEditing(false)} onSubmit={(v) => update.mutate({ job: v.job })} />
        </DialogContent>
      </Dialog>

      <Dialog open={reviewOpen && !!ex} onOpenChange={setReviewOpen}>
        <DialogContent title={ex?.purpose === "refresh" ? t("extraction.review.refreshTitle") : t("extraction.review.title")} size="xl">
          {ex && !isTerminal(ex.status) ? (
            <ExtractionProgress extraction={ex} />
          ) : ex?.result && ["succeeded", "partial", "needs_review"].includes(ex.status) ? (
            <ExtractionReview extraction={ex} onApplied={() => setReviewOpen(false)} onDismiss={() => setReviewOpen(false)} />
          ) : ex ? (
            <ExtractionFallback extraction={ex} onNewExtraction={setExtractionId} />
          ) : null}
        </DialogContent>
      </Dialog>

      <DeleteJobDialog
        jobId={job.id}
        title={`${displayCompany(job.company.name, t)} — ${displayTitle(local.posting.title, t)}`}
        open={deleting}
        onOpenChange={setDeleting}
        onArchive={() => status.mutate({ id: job.id, status: "archived" })}
        onDeleted={() => {
          toast.success(t("job.deleted"));
          setDeleting(false);
          void invalidate();
          navigate("/positions");
        }}
      />
    </div>
  );
}
