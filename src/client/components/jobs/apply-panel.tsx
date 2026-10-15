// Automated application (local Playwright worker): start dialog with the resume selector,
// live progress, questions that need the user, and the attempt history. Execution states are
// shown next to — never instead of — the job's pipeline status.
import type { ApplyOverview, AttemptDTO, AttemptState, PendingQuestion } from "@shared/apply";
import type { JobDetail } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, Copy, ExternalLink, Eye, FileText, Loader2, MonitorUp, PauseCircle, Send, ShieldCheck, XCircle } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, EmptyState, SectionTitle, Skeleton } from "@/components/ui/misc";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs } from "@/hooks/useJobMutations";
import { useLocaleContext } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";

const hostOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname : "";
  } catch {
    return "";
  }
};

const RUNNING: AttemptState[] = ["queued", "filling", "submitting"];
/** The worker is watching a visible window in these states (the user acts there). */
const WATCHING = ["manual_in_browser", "indeed_apply_assisted", "employer_site_manual"];
/** The user completed (or is completing) the application themselves and reports the result. */
const USER_COMPLETES = ["indeed_apply_assisted", "employer_site_manual", "confirm_result"];
const STATE_TONE: Record<AttemptState, "info" | "warn" | "ok" | "danger" | "neutral" | "violet"> = {
  queued: "info",
  filling: "info",
  needs_review: "warn",
  submitting: "violet",
  submitted_verified: "ok",
  submission_unconfirmed: "warn",
  failed: "danger",
  cancelled: "neutral",
};

export function useApplyOverview(jobId: string) {
  return useQuery({
    queryKey: ["apply", jobId],
    queryFn: () => api.get<ApplyOverview>(`/api/jobs/${jobId}/apply`),
    // Poll only while the worker is busy or a visible browser is open.
    refetchInterval: (q) => {
      const a = q.state.data?.attempts[0];
      return a && (RUNNING.includes(a.state) || WATCHING.includes(a.intervention ?? "") || a.stage === "waiting_for_you") ? 1500 : false;
    },
  });
}

export function AttemptStateBadge({ state, intervention, className }: { state: AttemptState; intervention?: string | null; className?: string }) {
  const { t } = useTranslation();
  const Icon = RUNNING.includes(state) ? Loader2 : state === "submitted_verified" ? CheckCircle2 : state === "needs_review" || state === "submission_unconfirmed" ? AlertTriangle : state === "failed" ? XCircle : PauseCircle;
  return (
    <Badge tone={STATE_TONE[state]} className={className} title={intervention ? t(`apply.intervention.${intervention}`) : undefined}>
      <Icon className={RUNNING.includes(state) ? "animate-spin" : undefined} />
      {t(`apply.state.${state}`)}
    </Badge>
  );
}

/** Small indicator for All Positions / Kanban (automation execution state only). */
export function AutomationBadge({ automation }: { automation: { state: AttemptState; intervention: string | null } | null | undefined }) {
  const { t } = useTranslation();
  if (!automation) return null;
  return (
    <span className="inline-flex items-center gap-1" aria-label={`${t("apply.automation")}: ${t(`apply.state.${automation.state}`)}`}>
      <Bot className="size-3 text-ink-4" aria-hidden />
      <AttemptStateBadge state={automation.state} intervention={automation.intervention} />
    </span>
  );
}

// ---------------------------------------------------------------- start dialog

export function StartApplicationDialog({ job, open, onOpenChange, onStarted }: { job: JobDetail; open: boolean; onOpenChange: (v: boolean) => void; onStarted: () => void }) {
  const { t, lang, tz } = useLocaleContext();
  const ov = useApplyOverview(job.id);
  const qc = useQueryClient();
  const onError = useToastError();
  const data = ov.data;
  const [resumeId, setResumeId] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"auto" | "review">("review");
  const [authorized, setAuthorized] = React.useState(false);
  // Indeed listings: follow the user's click in a window, or use the employer's link directly.
  const [route, setRoute] = React.useState<"window" | "link">("window");
  const [link, setLink] = React.useState("");
  // Workday: Autofill with Resume first; account automation only as authorised here, per employer.
  const [entryMode, setEntryMode] = React.useState<"autofill" | "manual">("autofill");
  const [signIn, setSignIn] = React.useState(false);
  const [createAccount, setCreateAccount] = React.useState(false);
  React.useEffect(() => {
    if (open && data) {
      // A preselected default still has to be confirmed with the authorization tick below.
      setResumeId((v) => v ?? data.default_resume_id);
      setAuthorized(false);
      setSignIn(!!data.account?.credential && !!data.account.auto_sign_in && !data.account.blocked);
      setCreateAccount(false);
      if (data.support.resolved_url) {
        setLink(data.support.resolved_url);
        setRoute("link");
      }
    }
  }, [open, data]);
  const isIndeed = data?.support.mode === "indeed";
  const linkOk = /^https?:\/\/\S+$/.test(link.trim());
  const start = useMutation({
    mutationFn: () =>
      api.post<AttemptDTO>(`/api/jobs/${job.id}/apply`, {
        resume_document_id: resumeId,
        submit_mode: mode,
        confirm: true,
        ...(isIndeed ? (route === "window" ? { indeed_window: true } : { target_url: link.trim() }) : {}),
        ...(data?.support.ats === "workday" || isIndeed ? { entry_mode: entryMode, account_mode: createAccount ? "create" : signIn ? "sign_in" : "none" } : {}),
      }),
    onSuccess: () => {
      toast.success(t("apply.started"));
      void qc.invalidateQueries({ queryKey: ["apply", job.id] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["board"] });
      onOpenChange(false);
      onStarted();
    },
    onError,
  });
  const selected = data?.resumes.find((r) => r.id === resumeId) ?? null;
  const missingRequired = data?.profile_check.filter((c) => c.required && !c.ok) ?? [];
  const canStart = !!data && data.support.supported && data.worker.available && !data.blocked_by && !!selected?.uploadable && !missingRequired.length && authorized && (!isIndeed || route === "window" || linkOk);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("apply.startTitle")} description={t("apply.startSubtitle")} size="lg">
        {!data ? (
          <Skeleton className="h-64" />
        ) : !data.support.supported ? (
          <ManualAssistance job={job} support={data.support} />
        ) : (
          <div className="space-y-5">
            {!data.worker.available ? <Notice tone="danger">{t(`apply.worker.${data.worker.reason ?? "no_browser"}`, { defaultValue: t("apply.worker.no_browser") })}</Notice> : null}
            {data.blocked_by ? <Notice tone="warn">{t(`apply.blocked.${data.blocked_by}`)}</Notice> : null}

            <section>
              <SectionTitle>{t("apply.chooseResume")}</SectionTitle>
              {data.resumes.length ? (
                <div role="radiogroup" aria-label={t("apply.chooseResume")} className="mt-2 max-h-72 space-y-1.5 overflow-y-auto scrollbar-thin pr-1">
                  {data.resumes.map((r) => (
                    <label
                      key={r.id}
                      className={cn("flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-[13px]", resumeId === r.id ? "border-accent bg-accent-soft/40" : "border-line hover:bg-subtle", !r.uploadable && "cursor-not-allowed opacity-60")}
                    >
                      <input type="radio" name="apply-resume" className="mt-1 accent-[var(--color-accent)]" checked={resumeId === r.id} disabled={!r.uploadable} onChange={() => setResumeId(r.id)} aria-label={r.version_name} />
                      <FileText className="mt-0.5 size-4 shrink-0 text-ink-3" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 font-medium text-ink">
                          {r.version_name}
                          {r.id === data.default_resume_id ? <Badge tone="accent">{t("apply.defaultResume")}</Badge> : null}
                          {!r.uploadable ? <Badge tone="neutral">{t("apply.notUploadable")}</Badge> : null}
                        </span>
                        <span className="block truncate text-xs text-ink-3">
                          {r.file_name} · {formatFileSize(r.size_bytes, lang)} · {t("apply.uploadedOn", { date: formatDate(r.created_at, lang, tz) })}
                        </span>
                        {r.notes ? <span className="block truncate text-xs text-ink-4">{r.notes}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-[13px] text-ink-3">
                  {t("apply.noResumes")}{" "}
                  <Link to="/documents" className="text-accent underline">
                    {t("nav.documents")}
                  </Link>
                </p>
              )}
            </section>

            <section className="rounded-md border border-line bg-canvas/60 px-3 py-2.5 text-[13px]">
              <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt className="text-ink-3">{t("fields.company_name")}</dt>
                <dd className="text-ink">{job.company.name}</dd>
                <dt className="text-ink-3">{t("fields.title")}</dt>
                <dd className="text-ink">{job.posting.title}</dd>
                <dt className="text-ink-3">{t("apply.applicationUrl")}</dt>
                <dd className="truncate text-ink-2" title={data.support.url ?? ""}>
                  {data.support.url}
                </dd>
                <dt className="text-ink-3">{t("apply.system")}</dt>
                <dd>{data.support.ats ? <Badge tone="ok">{t(`apply.ats.${data.support.ats}`, { defaultValue: data.support.ats })}</Badge> : <Badge tone="warn">{t("apply.ats.detect")}</Badge>}</dd>
                <dt className="text-ink-3">{t("apply.resume")}</dt>
                <dd className="text-ink">{selected ? `${selected.version_name} (${selected.file_name})` : <span className="text-warn">{t("apply.selectResume")}</span>}</dd>
              </dl>
            </section>

            {isIndeed ? (
              <section>
                <SectionTitle>{t("apply.indeed.title")}</SectionTitle>
                <p className="mt-1 text-xs text-ink-3">{t("apply.indeed.help")}</p>
                <div role="radiogroup" aria-label={t("apply.indeed.title")} className="mt-2 grid gap-2">
                  {(["window", "link"] as const).map((r) => (
                    <label key={r} className={cn("cursor-pointer rounded-md border px-3 py-2 text-[13px]", route === r ? "border-accent bg-accent-soft/40" : "border-line hover:bg-subtle")}>
                      <span className="flex items-center gap-2 font-medium text-ink">
                        <input type="radio" name="apply-route" checked={route === r} onChange={() => setRoute(r)} className="accent-[var(--color-accent)]" />
                        {t(`apply.indeed.${r}`)}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-3">{t(`apply.indeed.${r}Help`)}</span>
                      {r === "link" && route === "link" ? (
                        <Input className="mt-2" aria-label={t("apply.indeed.link")} placeholder={t("apply.indeed.linkPlaceholder")} value={link} onChange={(e) => setLink(e.target.value)} />
                      ) : null}
                    </label>
                  ))}
                </div>
              </section>
            ) : null}
            {data.support.ats === "workday" ? (
              <section className="space-y-3">
                <Notice tone="info">{t("apply.workdayNote")}</Notice>
                <div>
                  <SectionTitle>{t("apply.workday.entry")}</SectionTitle>
                  <div role="radiogroup" aria-label={t("apply.workday.entry")} className="mt-2 grid gap-2 sm:grid-cols-2">
                    {(["autofill", "manual"] as const).map((m) => (
                      <label key={m} className={cn("cursor-pointer rounded-md border px-3 py-2 text-[13px]", entryMode === m ? "border-accent bg-accent-soft/40" : "border-line hover:bg-subtle")}>
                        <span className="flex items-center gap-2 font-medium text-ink">
                          <input type="radio" name="apply-entry" checked={entryMode === m} onChange={() => setEntryMode(m)} className="accent-[var(--color-accent)]" />
                          {t(`apply.workday.${m}`)}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-3">{t(`apply.workday.${m}Help`)}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {data.account ? (
                  <div className="rounded-md border border-line px-3 py-2.5 text-[13px]">
                    <p className="font-medium text-ink">{t("apply.workday.account", { site: data.account.tenant })}</p>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {!data.account.available
                        ? t("apply.workday.noStore")
                        : !data.account.email
                          ? t("apply.workday.noEmail")
                          : data.account.credential
                            ? t("apply.workday.credentialSaved", { email: data.account.email })
                            : t("apply.workday.noCredential", { email: data.account.email })}
                      {data.account.blocked ? ` ${t("apply.workday.blocked")}` : ""}
                    </p>
                    <label className="mt-2 flex items-start gap-2">
                      <Checkbox checked={signIn} disabled={!data.account.credential || data.account.blocked} onCheckedChange={(v) => setSignIn(v === true)} aria-label={t("apply.workday.signIn")} className="mt-0.5" />
                      <span>{t("apply.workday.signIn")}</span>
                    </label>
                    <label className="mt-1 flex items-start gap-2">
                      <Checkbox checked={createAccount} disabled={!data.account.available || !data.account.email || data.account.credential || (data.account.password_mode === "shared" && !data.account.shared_configured)} onCheckedChange={(v) => setCreateAccount(v === true)} aria-label={t("apply.workday.create", { site: data.account.tenant })} className="mt-0.5" />
                      <span>
                        {t("apply.workday.create", { site: data.account.tenant })}
                        <span className="block text-xs text-ink-3">{data.account.password_mode === "shared" ? t("apply.workday.createShared") : t("apply.workday.createUnique")}</span>
                      </span>
                    </label>
                    <Link to="/settings#workday-accounts" className="mt-1 inline-block text-xs text-accent underline">
                      {t("apply.workday.manage")}
                    </Link>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section>
              <SectionTitle>{t("apply.profileCheck")}</SectionTitle>
              <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
                {data.profile_check.map((c) => (
                  <li key={c.key} className="flex items-center gap-1.5 text-[13px]">
                    {c.ok ? <CheckCircle2 className="size-3.5 text-ok" /> : c.required ? <XCircle className="size-3.5 text-danger" /> : <AlertTriangle className="size-3.5 text-warn" />}
                    <span className={c.ok ? "text-ink-2" : c.required ? "text-danger" : "text-ink-2"}>{t(`apply.check.${c.key}`)}</span>
                    {!c.ok ? <span className="text-xs text-ink-4">{c.required ? t("apply.required") : t("apply.askedIfNeeded")}</span> : null}
                  </li>
                ))}
              </ul>
              {data.profile_check.some((c) => !c.ok) ? (
                <Link to="/profile" className="mt-1 inline-block text-xs text-accent underline">
                  {t("apply.editProfile")}
                </Link>
              ) : null}
            </section>

            <section>
              <SectionTitle>{t("apply.submission")}</SectionTitle>
              <div role="radiogroup" aria-label={t("apply.submission")} className="mt-2 grid gap-2 sm:grid-cols-2">
                {(["review", "auto"] as const).map((m) => (
                  <label key={m} className={cn("cursor-pointer rounded-md border px-3 py-2 text-[13px]", mode === m ? "border-accent bg-accent-soft/40" : "border-line hover:bg-subtle")}>
                    <span className="flex items-center gap-2 font-medium text-ink">
                      <input type="radio" name="apply-mode" checked={mode === m} onChange={() => setMode(m)} className="accent-[var(--color-accent)]" />
                      {t(`apply.mode.${m}`)}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-3">{t(`apply.mode.${m}Help`)}</span>
                  </label>
                ))}
              </div>
            </section>

            <div className="rounded-md border border-line px-3 py-2.5 text-xs leading-relaxed text-ink-2">
              <p className="flex items-center gap-1.5 font-medium text-ink">
                <ShieldCheck className="size-4 text-ok" />
                {t("apply.safeguardsTitle")}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {(["never_invent", "ask_unknown", "no_demographic", "no_captcha", "verified_only", "local_only"] as const).map((k) => (
                  <li key={k}>{t(`apply.safeguards.${k}`)}</li>
                ))}
              </ul>
            </div>

            <label className="flex items-start gap-2 text-[13px] text-ink">
              <Checkbox checked={authorized} onCheckedChange={(v) => setAuthorized(v === true)} aria-label={t("apply.authorize")} className="mt-0.5" />
              <span>{mode === "auto" ? t("apply.authorizeAuto", { resume: selected?.version_name ?? "—", company: job.company.name }) : t("apply.authorizeReview", { resume: selected?.version_name ?? "—", company: job.company.name })}</span>
            </label>

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("actions.cancel")}
              </Button>
              <Button variant="primary" disabled={!canStart || start.isPending} onClick={() => start.mutate()}>
                {start.isPending ? <Loader2 className="animate-spin" /> : <Send />}
                {t("apply.start")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Notice({ tone, children }: { tone: "warn" | "danger" | "info"; children: React.ReactNode }) {
  const cls = { warn: "border-warn/25 bg-warn-soft text-warn", danger: "border-danger/25 bg-danger-soft text-danger", info: "border-info/20 bg-info-soft text-info" }[tone];
  return <div className={cn("rounded-md border px-3 py-2 text-[13px]", cls)}>{children}</div>;
}

// ---------------------------------------------------------------- manual assistance

/** The applicant's details from My Profile, each with a copy button. */
function ProfileCopyList() {
  const { t } = useTranslation();
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api.get<{ profile: import("@shared/profile").Profile }>("/api/profile") });
  const c = profile.data?.profile.contact;
  const b = profile.data?.profile.based_in;
  const rows: [string, string | null | undefined][] = [
    [t("profile.contact.first_name"), c?.first_name],
    [t("profile.contact.last_name"), c?.last_name],
    [t("profile.contact.email"), c?.email],
    [t("profile.contact.phone"), c?.phone],
    [t("profile.contact.linkedin_url"), c?.linkedin_url],
    [t("profile.contact.portfolio_url"), c?.portfolio_url],
    [t("apply.check.location"), [b?.city, b?.region, b?.country].filter(Boolean).join(", ")],
  ];
  const copy = (v: string) =>
    navigator.clipboard.writeText(v).then(
      () => toast.success(t("apply.copied")),
      () => toast.error(t("drafts.import.copyFailed")),
    );
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <li key={k} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
            <span className="w-32 shrink-0 text-ink-3">{k}</span>
            <span className="min-w-0 flex-1 truncate text-ink">{v}</span>
            <Button size="icon-sm" variant="ghost" aria-label={`${t("actions.copy")} ${k}`} onClick={() => copy(v!)}>
              <Copy />
            </Button>
          </li>
        ))}
    </ul>
  );
}

function ManualAssistance({ job, support }: { job: JobDetail; support: ApplyOverview["support"] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <Notice tone="info">{support.ats ? t("apply.manualFor", { site: t(`platform.${support.ats}`, { defaultValue: support.ats }) }) : support.url ? t("apply.manualUnknown") : t("apply.noUrl")}</Notice>
      <p className="text-[13px] text-ink-2">{t("apply.manualIntro")}</p>
      <ProfileCopyList />
      <div className="flex flex-wrap gap-2">
        {support.url ? (
          <Button asChild variant="primary">
            <a href={support.url} target="_blank" rel="noopener noreferrer nofollow">
              <ExternalLink />
              {t("apply.openApplication")}
            </a>
          </Button>
        ) : null}
        <p className="basis-full text-xs text-ink-3">{t("apply.manualThenMark", { title: job.posting.title })}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tab

export function ApplyTab({ job, onStart }: { job: JobDetail; onStart: () => void }) {
  const { t } = useTranslation();
  const ov = useApplyOverview(job.id);
  const invalidate = useInvalidateJobs();
  const current = ov.data?.attempts[0];
  // When the worker finishes, refresh the job (status may have become Applied).
  const prev = React.useRef(current?.state);
  React.useEffect(() => {
    if (prev.current && current && prev.current !== current.state) void invalidate();
    prev.current = current?.state;
  }, [current, invalidate]);

  if (!ov.data) return <Skeleton className="h-48" />;
  const d = ov.data;
  const showCard = !!current && !["failed", "cancelled"].includes(current.state);
  return (
    <div className="space-y-6">
      {showCard ? (
        <AttemptCard attempt={current!} jobId={job.id} />
      ) : (
        <EmptyState
          icon={<Bot />}
          title={d.support.supported ? t("apply.emptyTitle") : t("apply.manualTitle")}
          body={d.blocked_by === "already_applied" ? t("apply.blocked.already_applied") : d.support.supported ? t("apply.emptyBody") : t("apply.manualBody")}
          action={
            <Button variant="primary" onClick={onStart} disabled={d.support.supported && !!d.blocked_by}>
              <Send />
              {d.support.supported ? t("apply.startApplication") : t("apply.manualAssist")}
            </Button>
          }
        />
      )}
      {!showCard && current ? <AttemptCard attempt={current} jobId={job.id} /> : null}
      {d.attempts.length > 1 ? <History attempts={d.attempts.slice(1)} /> : null}
    </div>
  );
}

function useAttemptAction(jobId: string) {
  const qc = useQueryClient();
  const onError = useToastError();
  const invalidate = useInvalidateJobs();
  return useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) => api.post<AttemptDTO>(`/api/apply/attempts/${id}/${action}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["apply", jobId] });
      void qc.invalidateQueries({ queryKey: ["profile"] });
      void invalidate();
    },
    onError,
  });
}

const STEPPER: AttemptState[] = ["queued", "filling", "needs_review", "submitting", "submitted_verified"];

function AttemptCard({ attempt: a, jobId }: { attempt: AttemptDTO; jobId: string }) {
  const { t, lang, tz } = useLocaleContext();
  const act = useAttemptAction(jobId);
  const reached = STEPPER.indexOf(a.state);
  return (
    <section className="space-y-4" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <AttemptStateBadge state={a.state} intervention={a.intervention} />
        {a.ats ? <Badge tone="outline">{t(`apply.ats.${a.ats}`, { defaultValue: a.ats })}</Badge> : null}
        <Badge tone="outline">{t(`apply.mode.${a.submit_mode}`)}</Badge>
        <span className="text-xs text-ink-3">{t("apply.startedAt", { date: formatDateTime(a.created_at, lang, tz) })}</span>
        <span className="flex-1" />
        {["queued", "filling", "needs_review"].includes(a.state) ? (
          <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: "cancel" })}>
            <XCircle />
            {t("apply.cancel")}
          </Button>
        ) : null}
      </div>

      {reached >= 0 ? (
        <ol className="flex flex-wrap gap-1 text-[11px]" aria-label={t("apply.progress")}>
          {STEPPER.map((s, i) => (
            <li key={s} className={cn("rounded px-1.5 py-0.5", i < reached ? "bg-ok-soft text-ok" : i === reached ? "bg-accent-soft font-medium text-accent" : "bg-subtle text-ink-4")}>
              {t(`apply.state.${s}`)}
            </li>
          ))}
        </ol>
      ) : null}

      <p className="flex items-center gap-1.5 text-[13px] text-ink-2">
        <FileText className="size-4 text-ink-3" />
        {t("apply.resumeUsed", { name: a.resume.version_name, file: a.resume.file_name })}
        {!a.resume.still_available ? <Badge tone="warn">{t("apply.resumeGone")}</Badge> : a.resume.unchanged === false ? <Badge tone="warn">{t("apply.resumeChanged")}</Badge> : null}
      </p>

      {a.source_url ? (
        <p className="text-xs text-ink-3">
          {t(`apply.route.${a.route ?? "pending"}`, { host: hostOf(a.target_url) })} · {t("apply.routeFrom", { host: hostOf(a.source_url) })}
        </p>
      ) : null}

      {a.state === "needs_review" ? <Intervention key={`${a.id}:${a.updated_at}`} attempt={a} jobId={jobId} /> : null}

      {a.state === "submission_unconfirmed" ? (
        <div className="space-y-2 rounded-md border border-warn/25 bg-warn-soft px-3 py-2.5 text-[13px] text-ink-2">
          <p className="font-medium text-warn">{t("apply.unconfirmedTitle")}</p>
          <p>{t(`apply.unconfirmedReason.${a.error_code ?? "no_confirmation"}`, { defaultValue: t("apply.unconfirmedReason.no_confirmation") })}</p>
          <p>{t("apply.unconfirmedHelp")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: "resolve", body: { outcome: "submitted" } })}>
              {t("apply.resolveSubmitted")}
            </Button>
            <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: "resolve", body: { outcome: "not_submitted" } })}>
              {t("apply.resolveNotSubmitted")}
            </Button>
          </div>
        </div>
      ) : null}

      {a.state === "submitted_verified" ? (
        <div className="rounded-md border border-ok/25 bg-ok-soft px-3 py-2.5 text-[13px] text-ink-2">
          <p className="flex items-center gap-1.5 font-medium text-ok">
            <CheckCircle2 className="size-4" />
            {a.confirmation.source === "user" ? t("apply.confirmedByYou") : t("apply.confirmedByPage")}
          </p>
          {a.confirmation.text ? <blockquote className="mt-1 border-l-2 border-ok/40 pl-2 italic">{a.confirmation.text}</blockquote> : null}
          <p className="mt-1 text-xs text-ink-3">
            {formatDateTime(a.confirmation.at, lang, tz)}
            {a.confirmation.url ? ` · ${a.confirmation.url}` : ""}
          </p>
        </div>
      ) : null}

      {a.state === "failed" ? <Notice tone="danger">{t(`apply.error.${a.error_code ?? "worker_error"}`, { defaultValue: t("apply.error.worker_error") })}</Notice> : null}

      {a.filled.length ? (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-ink-2">{t("apply.filledCount", { count: a.filled.filter((f) => f.verified).length, total: a.filled.length })}</summary>
          <ul className="mt-1.5 space-y-0.5">
            {a.filled.map((f, i) => (
              <li key={i} className="flex items-center gap-1.5 text-xs">
                {f.verified ? <CheckCircle2 className="size-3 text-ok" /> : <AlertTriangle className="size-3 text-warn" />}
                <span className="text-ink-2">{f.label}</span>
                <span className="text-ink-4">· {t(`apply.source.${f.source.split(".")[0]}`, { defaultValue: f.source })}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {a.evidence.length ? (
        <div>
          <SectionTitle>{t("apply.evidence")}</SectionTitle>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {a.evidence.map((e) => (
              <a key={e} href={`/api/apply/attempts/${a.id}/evidence/${e}`} target="_blank" rel="noopener noreferrer" className="group block w-36 overflow-hidden rounded border border-line">
                <img src={`/api/apply/attempts/${a.id}/evidence/${e}`} alt={t(`apply.evidenceName.${e.replace(/\.png$/, "").replace(/-\d+$/, "")}`, { defaultValue: e })} className="h-24 w-full object-cover object-top" loading="lazy" />
                <span className="block truncate px-1.5 py-0.5 text-[11px] text-ink-3 group-hover:text-ink">{t(`apply.evidenceName.${e.replace(/\.png$/, "").replace(/-\d+$/, "")}`, { defaultValue: e })}</span>
              </a>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-4">{t("apply.evidenceNote")}</p>
        </div>
      ) : null}

      {a.steps.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-3">{t("apply.log")}</summary>
          <ol className="mt-1.5 space-y-0.5">
            {a.steps.map((s, i) => (
              <li key={i} className="text-ink-3">
                <span className="tabular-nums text-ink-4">{formatDateTime(s.at, lang, tz)}</span> · {t(`apply.step.${s.code}`, { ...(s.params ?? {}), reason: s.params?.reason ? t(`apply.intervention.${s.params.reason}`) : "", defaultValue: s.code })}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function Intervention({ attempt: a, jobId }: { attempt: AttemptDTO; jobId: string }) {
  const { t } = useTranslation();
  const act = useAttemptAction(jobId);
  // Values a site pre-filled from the resume are shown so the user can confirm or correct them.
  const [answers, setAnswers] = React.useState<Record<string, string | string[] | boolean>>(() => Object.fromEntries(a.questions.filter((q) => q.reason === "parsed_unverified" && q.hint && q.kind !== "radio").map((q) => [q.key, q.hint!])));
  const [remember, setRemember] = React.useState<Record<string, boolean>>({});
  const reason = a.intervention ?? "unexpected_page";
  const watching = WATCHING.includes(reason) || a.stage === "waiting_for_you";
  const helpKey = reason === "login_required" && a.ats === "workday" ? "login_required_workday" : reason;
  const answered = (q: PendingQuestion) => {
    const v = answers[q.key];
    return q.kind === "checkbox" ? v === true : Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim() !== "";
  };
  const allAnswered = a.questions.filter((q) => q.required).every(answered);
  return (
    <div className="space-y-3 rounded-md border border-warn/25 bg-warn-soft/50 px-3 py-3">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-warn">
        <AlertTriangle className="size-4" />
        {t(`apply.intervention.${reason}`)}
      </p>
      <p className="text-xs text-ink-2">{t(`apply.interventionHelp.${helpKey}`)}</p>
      {a.error_code && t(`apply.accountError.${a.error_code}`, { defaultValue: "" }) ? <p className="rounded bg-surface px-2 py-1 text-xs text-ink-2">{t(`apply.accountError.${a.error_code}`, { site: hostOf(a.target_url) })}</p> : null}
      {reason === "submit_approval" ? <ReviewSummary attempt={a} /> : null}
      {USER_COMPLETES.includes(reason) ? <UserCompletes attempt={a} onResolve={(outcome) => act.mutate({ id: a.id, action: "resolve", body: { outcome } })} busy={act.isPending} /> : null}
      {a.error_message && reason === "validation_errors" ? <p className="rounded bg-surface px-2 py-1 text-xs text-ink-2">{a.error_message}</p> : null}

      {a.questions.length && !USER_COMPLETES.includes(reason) ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate({ id: a.id, action: "answers", body: { answers, remember: Object.keys(remember).filter((k) => remember[k]) } });
          }}
        >
          {a.questions.map((q) => (
            <QuestionInput key={q.key} q={q} value={answers[q.key]} onChange={(v) => setAnswers((s) => ({ ...s, [q.key]: v }))} remember={!!remember[q.key]} onRemember={(v) => setRemember((s) => ({ ...s, [q.key]: v }))} />
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={!allAnswered || act.isPending}>
              {t("apply.continue")}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {reason === "submit_approval" || reason === "validation_errors" ? (
          <Button size="sm" variant="primary" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: "approve" })}>
            <Send />
            {reason === "validation_errors" ? t("apply.retrySubmit") : t("apply.approveSubmit")}
          </Button>
        ) : null}
        {!watching && reason !== "confirm_result" ? (
          <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: a.id, action: "visible" })} title={t("apply.visibleHelp")}>
            <MonitorUp />
            {t("apply.openVisible")}
          </Button>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-ink-2">
            <Eye className="size-3.5" />
            {t("apply.watchingWindow")}
          </span>
        )}
        <Button asChild size="sm" variant="ghost">
          <a href={a.target_url} target="_blank" rel="noopener noreferrer nofollow">
            <ExternalLink />
            {t("apply.openApplication")}
          </a>
        </Button>
      </div>
    </div>
  );
}

/** What is about to be submitted: resume, details, answers, and anything only the site's parsing provided. */
function ReviewSummary({ attempt: a }: { attempt: AttemptDTO }) {
  const { t } = useTranslation();
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => api.get<{ profile: import("@shared/profile").Profile }>("/api/profile") });
  const p = profile.data?.profile;
  const parsed = a.filled.filter((f) => f.status === "parsed");
  const corrected = a.filled.filter((f) => f.status === "corrected");
  const skipped = a.filled.filter((f) => f.status === "skipped");
  const show = (v: string | string[] | boolean) => (typeof v === "boolean" ? (v ? t("profile.tri.yes") : t("profile.tri.no")) : Array.isArray(v) ? v.join(", ") : v);
  return (
    <div className="space-y-2 rounded-md bg-surface px-3 py-2.5 text-xs text-ink-2">
      <p className="text-[13px] font-medium text-ink">{t("apply.review.title")}</p>
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-ink-3">{t("apply.resume")}</dt>
        <dd>
          {a.resume.version_name} ({a.resume.file_name})
        </dd>
        {p ? (
          <>
            <dt className="text-ink-3">{t("apply.review.contact")}</dt>
            <dd>{[`${p.contact.first_name ?? ""} ${p.contact.last_name ?? ""}`.trim(), p.contact.email, p.contact.phone, [p.based_in.city, p.based_in.region].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</dd>
            <dt className="text-ink-3">{t("apply.review.experience")}</dt>
            <dd>{p.experience.map((e) => `${e.title}${e.organization ? ` — ${e.organization}` : ""}`).join("; ") || "—"}</dd>
            <dt className="text-ink-3">{t("apply.review.education")}</dt>
            <dd>{p.education.map((e) => [e.institution, e.field].filter(Boolean).join(", ")).join("; ") || "—"}</dd>
          </>
        ) : null}
      </dl>
      {a.answered.length ? (
        <div>
          <p className="font-medium text-ink">{t("apply.review.answers")}</p>
          <ul className="mt-0.5 space-y-0.5">
            {a.answered.map((x) => (
              <li key={x.key}>
                <span className="text-ink-3">{x.label}</span> → {show(x.value)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {corrected.length ? <p>{t("apply.review.corrected", { fields: corrected.map((f) => f.label.replace(/\*$/, "")).join(", ") })}</p> : null}
      {skipped.length ? <p className="text-ink-3">{t("apply.review.skipped", { fields: skipped.map((f) => f.label.replace(/^Skills: /, "").replace(/\*$/, "")).join(", ") })}</p> : null}
      {parsed.length ? (
        <div className="rounded border border-warn/30 bg-warn-soft/40 px-2 py-1.5">
          <p className="font-medium text-warn">{t("apply.review.parsed")}</p>
          <ul className="mt-0.5 space-y-0.5">
            {parsed.map((f, i) => (
              <li key={i}>
                <span className="text-ink-3">{f.label.replace(/\*$/, "")}</span>: {f.value}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Indeed Apply / unsupported employer sites: the user applies; their resume and details are at hand. */
function UserCompletes({ attempt: a, onResolve, busy }: { attempt: AttemptDTO; onResolve: (o: "submitted" | "not_submitted") => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-md bg-surface px-3 py-2 text-[13px]">
      {a.resume.id && a.resume.still_available ? (
        <p>
          <a className="text-accent underline" href={`/api/documents/${a.resume.id}/content`}>
            {t("apply.downloadResume", { file: a.resume.file_name })}
          </a>
        </p>
      ) : null}
      <ProfileCopyList />
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onResolve("submitted")}>
          {t("apply.resolveSubmitted")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onResolve("not_submitted")}>
          {t("apply.resolveNotSubmitted")}
        </Button>
      </div>
    </div>
  );
}

function QuestionInput({ q, value, onChange, remember, onRemember }: { q: PendingQuestion; value: string | string[] | boolean | undefined; onChange: (v: string | string[] | boolean) => void; remember: boolean; onRemember: (v: boolean) => void }) {
  const { t } = useTranslation();
  const id = `q-${q.key.replace(/[^a-z0-9]/gi, "-")}`;
  const hint = [t(`apply.reason.${q.reason}`, { defaultValue: "" }), q.hint ? t("apply.profileSays", { value: t(`profile.languageLevel.${q.hint}`, { defaultValue: t(`profile.authStatus.${q.hint}`, { defaultValue: q.hint }) }) }) : ""].filter(Boolean).join(" ");
  let input: React.ReactNode;
  if (q.kind === "checkbox") {
    input = (
      <label className="flex items-start gap-2 text-[13px] text-ink">
        <Checkbox id={id} checked={value === true} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
        <span>{q.reason === "legal" ? t("apply.approveDeclaration") : t("apply.tick")}</span>
      </label>
    );
  } else if ((q.kind === "select" || q.kind === "radio") && q.options.length) {
    input = (
      <NativeSelect id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("apply.chooseOption")}</option>
        {q.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </NativeSelect>
    );
  } else if (q.kind === "multi" && q.options.length) {
    const list = Array.isArray(value) ? value : [];
    input = (
      <div className="flex flex-wrap gap-3">
        {q.options.map((o) => (
          <label key={o} className="flex items-center gap-1.5 text-[13px]">
            <Checkbox checked={list.includes(o)} onCheckedChange={(v) => onChange(v === true ? [...list, o] : list.filter((x) => x !== o))} />
            {o}
          </label>
        ))}
      </div>
    );
  } else if (q.kind === "textarea") {
    input = <Textarea id={id} rows={3} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  } else {
    input = <Input id={id} type={q.kind === "date" ? "date" : q.kind === "number" ? "number" : "text"} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="rounded-md bg-surface px-3 py-2">
      <Field label={<span>{q.label}{q.sensitive ? <Badge tone="violet" className="ml-1.5">{t("apply.sensitive")}</Badge> : null}</span>} htmlFor={id} hint={hint || undefined}>
        {input}
      </Field>
      {q.reason !== "unsupported" && q.rememberable !== false ? (
        <label className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-3">
          <Checkbox checked={remember} onCheckedChange={(v) => onRemember(v === true)} aria-label={t("apply.remember")} />
          {q.meaning === "identity" ? t("apply.rememberExact") : q.meaning === "prior_employment" ? t("apply.rememberEmployer") : q.meaning ? t("apply.rememberDefault") : t("apply.remember")}
        </label>
      ) : null}
    </div>
  );
}

function History({ attempts }: { attempts: AttemptDTO[] }) {
  const { t, lang, tz } = useLocaleContext();
  return (
    <section>
      <SectionTitle>{t("apply.history")}</SectionTitle>
      <ul className="mt-1.5 divide-y divide-line rounded-md border border-line">
        {attempts.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
            <AttemptStateBadge state={a.state} />
            <span className="text-ink-2">{a.resume.version_name}</span>
            <span className="text-xs text-ink-4">{formatDateTime(a.created_at, lang, tz)}</span>
            {a.error_code ? <span className="text-xs text-ink-3">· {t(`apply.error.${a.error_code}`, { defaultValue: a.error_code })}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
