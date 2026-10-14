// Settings → Workday accounts. Passwords are stored in the macOS Keychain by the local server and
// are never sent back to the browser: this panel only ever shows whether one is saved.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Mail, ShieldCheck, Trash2 } from "lucide-react";
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
  const [ex, setEx] = React.useState({ site: "", email: "", password: "" });
  const saveExisting = useMutation({
    meta: { notASave: true },
    mutationFn: () => api.put<AccountsView>("/api/local/accounts/existing", ex),
    onSuccess: (v) => {
      done(v);
      const tenant = v.accounts.find((a) => ex.site.toLowerCase().includes(a.tenant))?.tenant ?? ex.site;
      toast.success(t("accounts.existingSaved", { tenant }));
      setEx({ site: "", email: "", password: "" });
    },
    onError,
  });
  const copy = useMutation({
    meta: { notASave: true },
    mutationFn: (x: { tenant: string; email: string }) => api.post(`/api/local/accounts/${encodeURIComponent(x.tenant)}/copy?email=${encodeURIComponent(x.email)}`, {}),
    onSuccess: () => toast.success(t("accounts.copied")),
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
                      <Button size="icon-sm" variant="ghost" title={t("accounts.copy")} aria-label={`${t("accounts.copy")} ${a.tenant}`} onClick={() => copy.mutate({ tenant: a.tenant, email: a.email })}>
                        <Copy />
                      </Button>
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
            <div className="rounded-md border border-line px-3 py-3">
              <p className="flex items-center gap-1.5 font-medium text-ink">
                <KeyRound className="size-4" />
                {t("accounts.existingTitle")}
              </p>
              <p className="mt-1 text-xs text-ink-3">{t("accounts.existingHelp")}</p>
              <form
                className="mt-2 grid gap-2 sm:grid-cols-[2fr_1.4fr_1fr_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveExisting.mutate();
                }}
              >
                <Input aria-label={t("accounts.existingSite")} placeholder={t("accounts.existingSitePlaceholder")} value={ex.site} onChange={(e) => setEx({ ...ex, site: e.target.value })} />
                <Input type="email" autoComplete="username" aria-label={t("accounts.existingEmail")} placeholder={t("accounts.existingEmail")} value={ex.email} onChange={(e) => setEx({ ...ex, email: e.target.value })} />
                <Input type="password" autoComplete="current-password" aria-label={t("accounts.existingPassword")} placeholder={t("accounts.existingPassword")} value={ex.password} onChange={(e) => setEx({ ...ex, password: e.target.value })} />
                <Button type="submit" variant="primary" disabled={!ex.site || !ex.email || !ex.password || saveExisting.isPending}>
                  {t("accounts.existingSave")}
                </Button>
              </form>
            </div>
            <GmailSection />
          </>
        )}
      </div>
      <ConfirmDialog open={!!forget} onOpenChange={(o) => !o && setForget(null)} title={t("accounts.forgetTitle")} body={t("accounts.forgetBody", { tenant: forget?.tenant ?? "" })} confirmLabel={t("accounts.forget")} destructive onConfirm={() => forget && forgetM.mutate(forget)} />
    </Card>
  );
}

interface MailView {
  available: boolean;
  store: "keychain" | "memory" | null;
  enabled: boolean;
  address: string;
  profile_email: string | null;
  effective_address: string | null;
  password_saved: boolean;
}

/** Gmail verification e-mails: on/off, address, app password (write-only), connection test. */
function GmailSection() {
  const { t } = useLocaleContext();
  const qc = useQueryClient();
  const onError = useToastError();
  const view = useQuery({ queryKey: ["local-mail"], queryFn: () => api.get<MailView>("/api/local/mail") });
  const done = (v: MailView) => {
    qc.setQueryData(["local-mail"], v);
    void qc.invalidateQueries({ queryKey: ["apply"] });
  };
  const [address, setAddress] = React.useState<string | null>(null);
  const [pw, setPw] = React.useState("");
  const put = useMutation({ meta: { notASave: true }, mutationFn: (body: Record<string, unknown>) => api.put<MailView>("/api/local/mail", body), onSuccess: done, onError });
  const remove = useMutation({ meta: { notASave: true }, mutationFn: () => api.delete<MailView>("/api/local/mail/password"), onSuccess: done, onError });
  const check = useMutation({
    meta: { notASave: true },
    mutationFn: () => api.post<{ result: "ok" | "auth_failed" | "unreachable" | "not_configured" }>("/api/local/mail/check", {}),
    onSuccess: (r) => (r.result === "ok" ? toast.success(t("accounts.mail.check.ok")) : toast.error(t(`accounts.mail.check.${r.result}`))),
    onError,
  });
  const v = view.data;
  if (!v || !v.available) return null;
  const addr = address ?? v.address;
  return (
    <div className="rounded-md border border-line px-3 py-3" id="gmail-verification">
      <p className="flex items-center gap-1.5 font-medium text-ink">
        <Mail className="size-4" />
        {t("accounts.mail.title")} {v.password_saved ? <Badge tone="ok">{t("accounts.mail.passwordSaved")}</Badge> : <Badge tone="warn">{t("accounts.mail.passwordMissing")}</Badge>}
      </p>
      <p className="mt-1 text-xs text-ink-3">{t("accounts.mail.intro")}</p>
      <label className="mt-2 flex items-start gap-2">
        <Checkbox checked={v.enabled} onCheckedChange={(c) => put.mutate({ enabled: c === true })} aria-label={t("accounts.mail.enabled")} className="mt-0.5" />
        <span>{t("accounts.mail.enabled")}</span>
      </label>
      <form
        className="mt-2 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          put.mutate(
            { address: addr, ...(pw ? { app_password: pw } : {}) },
            {
              onSuccess: () => {
                setPw("");
                setAddress(null);
                toast.success(t("accounts.mail.saved"));
              },
            },
          );
        }}
      >
        <Field label={t("accounts.mail.address")} htmlFor="gmail-address" hint={v.profile_email ? t("accounts.mail.addressHelp", { email: v.profile_email }) : undefined}>
          <Input id="gmail-address" type="email" autoComplete="email" placeholder={v.profile_email ?? ""} value={addr} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label={t("accounts.mail.appPassword")} htmlFor="gmail-app-password" hint={t("accounts.mail.appPasswordHelp")}>
          <Input id="gmail-app-password" type="password" autoComplete="off" placeholder="xxxx xxxx xxxx xxxx" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" disabled={put.isPending || (!pw && addr === v.address)}>
            {t("accounts.mail.save")}
          </Button>
          <Button type="button" variant="secondary" disabled={check.isPending || !v.password_saved} onClick={() => check.mutate()}>
            {t("accounts.mail.test")}
          </Button>
          <a className="text-xs text-accent underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer noopener">
            {t("accounts.mail.howTo")}
          </a>
          {v.password_saved ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => remove.mutate()}>
              <Trash2 />
              {t("accounts.mail.remove")}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
