// Settings → Workday accounts. Passwords are stored in the macOS Keychain by the local server and
// are never sent back to the browser: this panel only ever shows whether one is saved.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Card, CardHeader, Checkbox } from "@/components/ui/misc";
import { useToastError } from "@/hooks/useApiError";
import { useLocaleContext } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface AccountsView {
  available: boolean;
  store: "keychain" | "memory" | null;
  password_mode: "unique" | "shared";
  auto_sign_in: boolean;
  shared_configured: boolean;
  accounts: { tenant: string; email: string; mode: "unique" | "shared"; status: string; created_at: number; last_sign_in_at: number | null; last_failure_at: number | null }[];
}

export function WorkdayAccountsSection() {
  const { t, lang, tz } = useLocaleContext();
  const qc = useQueryClient();
  const onError = useToastError();
  const view = useQuery({ queryKey: ["local-accounts"], queryFn: () => api.get<AccountsView>("/api/local/accounts") });
  const done = (v: AccountsView) => qc.setQueryData(["local-accounts"], v);
  const patch = useMutation({ meta: { notASave: true }, mutationFn: (body: Record<string, unknown>) => api.patch<AccountsView>("/api/local/accounts", body), onSuccess: done, onError });
  const [pw, setPw] = React.useState("");
  const [pw2, setPw2] = React.useState("");
  const saveShared = useMutation({
    meta: { notASave: true },
    mutationFn: () => api.put<AccountsView>("/api/local/accounts/shared-password", { password: pw, confirm: pw2 }),
    onSuccess: (v) => {
      done(v);
      setPw("");
      setPw2("");
      toast.success(t("accounts.sharedSaved"));
    },
    onError,
  });
  const delShared = useMutation({ meta: { notASave: true }, mutationFn: () => api.delete<AccountsView>("/api/local/accounts/shared-password"), onSuccess: done, onError });
  const [forget, setForget] = React.useState<{ tenant: string; email: string } | null>(null);
  const forgetM = useMutation({
    meta: { notASave: true },
    mutationFn: (x: { tenant: string; email: string }) => api.delete<AccountsView>(`/api/local/accounts/${encodeURIComponent(x.tenant)}?email=${encodeURIComponent(x.email)}`),
    onSuccess: (v) => {
      done(v);
      setForget(null);
    },
    onError,
  });
  const v = view.data;
  return (
    <Card id="workday-accounts">
      <CardHeader title={t("accounts.title")} description={t("accounts.intro")} />
      <div className="space-y-4 px-4 pb-4 text-[13px]">
        {!v ? null : !v.available ? (
          <p className="text-warn">{t("accounts.unavailable")}</p>
        ) : (
          <>
            <p className="flex items-center gap-1.5 text-ink-2">
              <ShieldCheck className="size-4 text-ok" />
              {v.store === "keychain" ? t("accounts.storeKeychain") : t("accounts.storeMemory")}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("accounts.passwordMode")} htmlFor="acc-mode" hint={t(`accounts.modeHelp.${v.password_mode}`)}>
                <NativeSelect id="acc-mode" value={v.password_mode} onChange={(e) => patch.mutate({ password_mode: e.target.value })}>
                  <option value="unique">{t("accounts.mode.unique")}</option>
                  <option value="shared">{t("accounts.mode.shared")}</option>
                </NativeSelect>
              </Field>
              <label className="flex items-start gap-2 pt-6">
                <Checkbox checked={v.auto_sign_in} onCheckedChange={(c) => patch.mutate({ auto_sign_in: c === true })} aria-label={t("accounts.autoSignIn")} className="mt-0.5" />
                <span>
                  {t("accounts.autoSignIn")}
                  <span className="block text-xs text-ink-3">{t("accounts.autoSignInHelp")}</span>
                </span>
              </label>
            </div>
            {v.password_mode === "shared" ? (
              <div className="rounded-md border border-line px-3 py-3">
                <p className="flex items-center gap-1.5 font-medium text-ink">
                  <KeyRound className="size-4" />
                  {t("accounts.sharedTitle")} {v.shared_configured ? <Badge tone="ok">{t("accounts.saved")}</Badge> : <Badge tone="warn">{t("accounts.notSet")}</Badge>}
                </p>
                <p className="mt-1 text-xs text-ink-3">{t("accounts.sharedHelp")}</p>
                <form
                  className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveShared.mutate();
                  }}
                >
                  <Input type="password" autoComplete="new-password" aria-label={t("accounts.newPassword")} placeholder={t("accounts.newPassword")} value={pw} onChange={(e) => setPw(e.target.value)} />
                  <Input type="password" autoComplete="new-password" aria-label={t("accounts.confirmPassword")} placeholder={t("accounts.confirmPassword")} value={pw2} onChange={(e) => setPw2(e.target.value)} />
                  <Button type="submit" variant="primary" disabled={!pw || !pw2 || saveShared.isPending}>
                    {v.shared_configured ? t("accounts.replace") : t("accounts.saveToKeychain")}
                  </Button>
                </form>
                {v.shared_configured ? (
                  <Button size="sm" variant="ghost" className="mt-1" onClick={() => delShared.mutate()}>
                    <Trash2 />
                    {t("accounts.removeShared")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div>
              <p className="mb-1 text-xs font-medium text-ink-3">{t("accounts.list")}</p>
              {v.accounts.length ? (
                <ul className="divide-y divide-line rounded-md border border-line">
                  {v.accounts.map((a) => (
                    <li key={`${a.tenant}|${a.email}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-ink">{a.tenant}</span>
                      <span className="text-xs text-ink-3">{a.email}</span>
                      <Badge tone={a.last_failure_at ? "warn" : "outline"}>{a.last_failure_at ? t("accounts.lastFailed") : t(`accounts.status.${a.status}`, { defaultValue: a.status })}</Badge>
                      <span className="text-xs text-ink-4">{formatDateTime(a.created_at, lang, tz)}</span>
                      <Button size="icon-sm" variant="ghost" aria-label={`${t("accounts.forget")} ${a.tenant}`} onClick={() => setForget({ tenant: a.tenant, email: a.email })}>
                        <Trash2 />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-3">{t("accounts.none")}</p>
              )}
            </div>
          </>
        )}
      </div>
      <ConfirmDialog open={!!forget} onOpenChange={(o) => !o && setForget(null)} title={t("accounts.forgetTitle")} body={t("accounts.forgetBody", { tenant: forget?.tenant ?? "" })} confirmLabel={t("accounts.forget")} destructive onConfirm={() => forget && forgetM.mutate(forget)} />
    </Card>
  );
}
