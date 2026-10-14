// Settings panel for the local (Mac) runtime: where the data lives, weekly encrypted backups,
// and the optional Claude Code AI provider.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, ShieldCheck, Sparkles } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader } from "@/components/ui/misc";
import { useToastError } from "@/hooks/useApiError";
import { useLocaleContext } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";

interface LocalStatus {
  instance: string;
  data_dir: string;
  database: string;
  documents_dir: string;
  schema_version: string | null;
  backup: {
    backup_dir: string;
    interval_days: number;
    keep: number;
    count: number;
    last_success_at: string | null;
    next_due_at: string | null;
    last_error: string | null;
    last_verified_restore_at: string | null;
    total_bytes: number;
  };
  tasks: { running: number; queued: number; retrying: number };
  ai: { provider: string; claude: { available: boolean; path: string | null; version: string | null; logged_in: boolean; auth_method: string | null; subscription: boolean; reason?: string } };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export function LocalDataSection() {
  const { t, lang, tz } = useLocaleContext();
  const qc = useQueryClient();
  const onError = useToastError();
  const status = useQuery({ queryKey: ["local-status"], queryFn: () => api.get<LocalStatus>("/api/local/status"), refetchInterval: 60_000 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["local-status"] });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const backup = useMutation({
    meta: { notASave: true },
    mutationFn: () => api.post<{ name: string; rows: number; key_created: boolean }>("/api/local/backup"),
    onSuccess: (r) => {
      toast.success(t("local.backupDone", { rows: r.rows }));
      if (r.key_created) toast.warning(t("local.keyCreated"), { duration: Infinity });
      refresh();
    },
    onError,
  });
  const verify = useMutation({
    meta: { notASave: true },
    mutationFn: () => api.post<{ name: string; rows: number }>("/api/local/backup/verify"),
    onSuccess: (r) => toast.success(t("local.verifyDone", { rows: r.rows })),
    onError,
  });
  const setAi = useMutation({
    mutationFn: (provider: "none" | "claude_code") => api.patch("/api/local/settings", { ai_provider: provider }),
    onSuccess: refresh,
    onError,
  });
  const check = useMutation({ meta: { notASave: true }, mutationFn: () => api.post("/api/local/ai/check"), onSuccess: refresh, onError });

  const s = status.data;
  if (!s) return null;
  const when = (iso: string | null) => (iso ? `${formatDateTime(Date.parse(iso), lang, tz)} (${formatRelative(Date.parse(iso), lang)})` : t("local.never"));
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-3 border-b border-line/60 py-1.5 text-[13px] last:border-0">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 break-all text-right">{value}</dd>
    </div>
  );
  const claude = s.ai.claude;
  const aiOn = s.ai.provider === "claude_code";

  return (
    <>
      <Card id="local-data">
        <CardHeader title={t("local.title")} description={t("local.intro")} />
        <div className="grid gap-6 px-4 pb-4 lg:grid-cols-2">
          <dl>
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-3">
              <HardDrive className="size-3.5" aria-hidden />
              {t("local.storage")}
            </p>
            {row(t("local.dataDir"), <code className="text-xs">{s.data_dir}</code>)}
            {row(t("local.schema"), s.schema_version ?? "—")}
            {row(t("local.autosave"), t("local.autosaveOn"))}
          </dl>
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-3">
              <ShieldCheck className="size-3.5" aria-hidden />
              {t("local.backups")}
            </p>
            <dl>
              {row(t("local.schedule"), t("local.scheduleValue", { days: s.backup.interval_days, keep: s.backup.keep }))}
              {row(t("local.lastBackup"), when(s.backup.last_success_at))}
              {row(t("local.nextBackup"), s.backup.next_due_at ? formatDateTime(Date.parse(s.backup.next_due_at), lang, tz) : t("local.dueNow"))}
              {row(t("local.lastRestoreTest"), when(s.backup.last_verified_restore_at))}
              {row(t("local.backupCount"), `${s.backup.count} · ${mb(s.backup.total_bytes)}`)}
              {row(t("local.backupDir"), <code className="text-xs">{s.backup.backup_dir}</code>)}
            </dl>
            {s.backup.last_error ? <p className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{t("local.lastError", { error: s.backup.last_error })}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" disabled={backup.isPending} onClick={() => backup.mutate()}>
                {backup.isPending ? t("local.backingUp") : t("local.backupNow")}
              </Button>
              <Button variant="secondary" disabled={verify.isPending || s.backup.count === 0} onClick={() => verify.mutate()}>
                {verify.isPending ? t("local.verifying") : t("local.verify")}
              </Button>
            </div>
            <p className="mt-2 text-xs text-ink-4">{t("local.restoreHelp")}</p>
          </div>
        </div>
      </Card>

      <Card id="local-ai">
        <CardHeader title={t("local.aiTitle")} description={t("local.aiIntro")} />
        <div className="space-y-3 px-4 pb-4 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-4 text-accent" aria-hidden />
            <span className="font-medium">Claude Code</span>
            {claude.subscription ? (
              <Badge tone="ok">{t("local.claudeReady")}</Badge>
            ) : (
              <Badge tone="warn">{claude.path ? (claude.reason === "not_subscription_auth" ? t("local.claudeNotSubscription") : t("local.claudeSignedOut")) : t("local.claudeMissing")}</Badge>
            )}
            {claude.version ? <span className="text-xs text-ink-4">v{claude.version}</span> : null}
            <Button variant="ghost" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
              {t("local.recheck")}
            </Button>
          </div>
          {!claude.subscription ? <p className="text-xs text-ink-3">{t("local.claudeHowTo")}</p> : null}
          <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">{t("local.aiNotice")}</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4" checked={aiOn} disabled={setAi.isPending || (!aiOn && !claude.subscription)} onChange={(e) => setAi.mutate(e.target.checked ? "claude_code" : "none")} />
            {t("local.aiEnable")}
          </label>
        </div>
      </Card>
    </>
  );
}
