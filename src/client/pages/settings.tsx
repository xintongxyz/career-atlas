import { CONTACT_KINDS, EMPLOYMENT_TYPES, SALARY_PERIODS, WORK_MODES } from "@shared/constants";
import type { ComparisonPrefs } from "@shared/schemas";
import type { ContactDTO } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileJson, Pencil, Plus, Trash2, Upload } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LanguageToggle } from "@/components/layout/language-toggle";
import { ShortcutList } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Card, CardHeader, Checkbox } from "@/components/ui/misc";
import { TagInput } from "@/components/ui/tag-input";
import { useToastError } from "@/hooks/useApiError";
import { useInvalidateJobs } from "@/hooks/useJobMutations";
import { useLocaleContext } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { downloadBlob } from "@/lib/utils";
import { LocalDataSection } from "./settings-local";
import { PageHeader } from "./system";

function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? ["America/Toronto", "America/Vancouver", "America/New_York", "Europe/London", "Asia/Shanghai", "UTC"];
  } catch {
    return ["America/Toronto", "UTC"];
  }
}

export default function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="max-w-4xl">
      <PageHeader title={t("settings.title")} />
      <nav className="mb-4 flex flex-wrap gap-3 text-xs text-ink-3">
        {(["general", "preferences", "tags", "contacts", "local", "data", "system"] as const).map((s) => (
          <a key={s} href={s === "local" ? "#local-data" : `#${s}`} className="hover:text-ink">
            {t(`settings.sections.${s}`)}
          </a>
        ))}
      </nav>
      <div className="space-y-5">
        <GeneralSection />
        <PreferencesSection />
        <TagsSection />
        <ContactsSection />
        <LocalDataSection />
        <DataSection />
        <SystemSection />
      </div>
    </div>
  );
}

function usePrefs() {
  const qc = useQueryClient();
  const onError = useToastError();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch("/api/me/preferences", body),
    onSuccess: () => {
      toast.success(t("settings.saved"));
      void qc.invalidateQueries({ queryKey: ["me"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError,
  });
}

function GeneralSection() {
  const { t, me } = useLocaleContext();
  const save = usePrefs();
  const zones = React.useMemo(timeZones, []);
  return (
    <Card id="general">
      <CardHeader title={t("settings.sections.general")} />
      <div className="grid gap-4 px-4 pb-4 sm:grid-cols-3">
        <Field label={t("settings.language")}>
          <LanguageToggle />
        </Field>
        <Field label={t("settings.timezone")} htmlFor="set-tz" hint={t("settings.timezoneHelp")}>
          <NativeSelect id="set-tz" value={me?.preferences.timezone ?? "America/Toronto"} onChange={(e) => save.mutate({ timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t("settings.followUpDays")} htmlFor="set-fu" hint={t("settings.followUpHelp")}>
          <Input
            id="set-fu"
            type="number"
            min={0}
            max={90}
            key={me?.preferences.default_follow_up_days}
            defaultValue={me?.preferences.default_follow_up_days ?? 7}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 0 && v <= 90 && v !== me?.preferences.default_follow_up_days) save.mutate({ default_follow_up_days: v });
            }}
          />
        </Field>
      </div>
    </Card>
  );
}

function PreferencesSection() {
  const { t, me } = useLocaleContext();
  const save = usePrefs();
  const [prefs, setPrefs] = React.useState<ComparisonPrefs | null>(null);
  React.useEffect(() => {
    if (me) setPrefs(me.preferences.comparison);
  }, [me]);
  if (!prefs) return null;
  const toggle = <K extends "preferred_work_modes" | "preferred_employment_types">(key: K, v: ComparisonPrefs[K][number]) => {
    const list = prefs[key] as string[];
    setPrefs({ ...prefs, [key]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] });
  };
  return (
    <Card id="preferences">
      <CardHeader title={t("settings.sections.preferences")} description={t("settings.prefs.intro")} />
      <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2">
        <Field label={t("settings.prefs.workModes")}>
          <div className="flex flex-wrap gap-3">
            {WORK_MODES.filter((m) => m !== "unspecified").map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-[13px]">
                <Checkbox checked={prefs.preferred_work_modes.includes(m)} onCheckedChange={() => toggle("preferred_work_modes", m)} />
                {t(`workMode.${m}`)}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("settings.prefs.employmentTypes")}>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {EMPLOYMENT_TYPES.filter((m) => m !== "unknown" && m !== "other").map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-[13px]">
                <Checkbox checked={prefs.preferred_employment_types.includes(m)} onCheckedChange={() => toggle("preferred_employment_types", m)} />
                {t(`employmentType.${m}`)}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("settings.prefs.cities")}>
          <TagInput value={prefs.preferred_cities} onChange={(v) => setPrefs({ ...prefs, preferred_cities: v })} placeholder={t("settings.prefs.citiesPlaceholder")} />
        </Field>
        <Field label={t("settings.prefs.categories")}>
          <TagInput value={prefs.preferred_categories} onChange={(v) => setPrefs({ ...prefs, preferred_categories: v })} placeholder={t("settings.prefs.categoriesPlaceholder")} />
        </Field>
        <Field label={t("settings.prefs.minSalary")} hint={t("salary.notComparable")} className="sm:col-span-2">
          <div className="grid grid-cols-3 gap-2 sm:max-w-md">
            <Input type="number" min={0} value={prefs.min_salary ?? ""} onChange={(e) => setPrefs({ ...prefs, min_salary: e.target.value === "" ? null : Number(e.target.value) })} aria-label={t("salary.min")} />
            <Input maxLength={3} placeholder="CAD" value={prefs.min_salary_currency ?? ""} onChange={(e) => setPrefs({ ...prefs, min_salary_currency: e.target.value.toUpperCase() || null })} aria-label={t("salary.currency")} />
            <NativeSelect value={prefs.min_salary_period} onChange={(e) => setPrefs({ ...prefs, min_salary_period: e.target.value as ComparisonPrefs["min_salary_period"] })} aria-label={t("salary.period.annually")}>
              {SALARY_PERIODS.filter((p) => p !== "unknown" && p !== "other").map((p) => (
                <option key={p} value={p}>
                  {t(`salary.period.${p}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
        </Field>
        <Field label={t("settings.prefs.weights")} className="sm:col-span-2">
          <div className="grid gap-2 sm:grid-cols-5">
            {(Object.keys(prefs.weights) as (keyof ComparisonPrefs["weights"])[]).map((k) => (
              <label key={k} className="text-xs text-ink-3">
                {t(`compare.criteria.${k}`)}
                <input type="range" min={0} max={5} step={1} value={prefs.weights[k]} onChange={(e) => setPrefs({ ...prefs, weights: { ...prefs.weights, [k]: Number(e.target.value) } })} className="mt-1 w-full accent-[var(--color-accent)]" />
                <span className="tabular">{prefs.weights[k]}</span>
              </label>
            ))}
          </div>
        </Field>
        <div className="sm:col-span-2">
          <Button variant="primary" onClick={() => save.mutate({ comparison: prefs })} disabled={save.isPending || (prefs.min_salary != null && !/^[A-Z]{3}$/.test(prefs.min_salary_currency ?? ""))}>
            {t("actions.save")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function TagsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const invalidate = useInvalidateJobs();
  const onError = useToastError();
  const tags = useQuery({ queryKey: ["tags"], queryFn: () => api.get<{ items: { id: string; name: string; usage: number }[] }>("/api/tags") });
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tags"] });
    void invalidate();
  };
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => api.patch(`/api/tags/${v.id}`, { name: v.name }), onSuccess: () => { setRenaming(null); refresh(); }, onError });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/api/tags/${id}`), onSuccess: () => { setDeleting(null); refresh(); }, onError });
  return (
    <Card id="tags">
      <CardHeader title={t("settings.sections.tags")} />
      <div className="px-4 pb-4">
        {!tags.data?.items.length ? (
          <p className="text-[13px] text-ink-4">{t("settings.tags.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {tags.data.items.map((tg) => (
              <li key={tg.id} className="flex items-center gap-2 py-2 text-[13px]">
                {renaming?.id === tg.id ? (
                  <form
                    className="flex flex-1 gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      rename.mutate(renaming);
                    }}
                  >
                    <Input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} maxLength={40} />
                    <Button type="submit" size="md" variant="primary">
                      {t("actions.save")}
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className="flex-1">{tg.name}</span>
                    <span className="text-xs text-ink-4">{t("settings.tags.usage", { count: Number(tg.usage) })}</span>
                    <Button variant="ghost" size="icon-sm" aria-label={t("settings.tags.rename")} onClick={() => setRenaming({ id: tg.id, name: tg.name })}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label={t("actions.delete")} onClick={() => setDeleting(tg.id)}>
                      <Trash2 />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t("common.confirmDeleteTitle")} body={t("settings.tags.deleteBody")} onConfirm={() => deleting && del.mutate(deleting)} />
    </Card>
  );
}

function ContactsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onError = useToastError();
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: () => api.get<{ items: ContactDTO[] }>("/api/contacts") });
  const [editing, setEditing] = React.useState<Partial<ContactDTO> | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const save = useMutation({
    mutationFn: (c: Partial<ContactDTO>) => {
      const body = { name: c.name, kind: c.kind ?? "other", title: c.title || null, email: c.email || null, phone: c.phone || null, linkedin_url: c.linkedin_url || null, notes: c.notes || null };
      return c.id ? api.patch(`/api/contacts/${c.id}`, body) : api.post("/api/contacts", body);
    },
    onSuccess: () => {
      toast.success(t("contacts.created"));
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/contacts/${id}`),
    onSuccess: () => {
      toast(t("contacts.deleted"));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError,
  });
  const field = (k: keyof ContactDTO, label: string, type = "text") => (
    <Field label={label} htmlFor={`ct-${k}`}>
      <Input id={`ct-${k}`} type={type} value={(editing?.[k] as string) ?? ""} onChange={(e) => setEditing((c) => ({ ...c, [k]: e.target.value }))} required={k === "name"} />
    </Field>
  );
  return (
    <Card id="contacts">
      <CardHeader
        title={t("settings.sections.contacts")}
        action={
          <Button size="sm" onClick={() => setEditing({ kind: "recruiter" })}>
            <Plus />
            {t("contacts.add")}
          </Button>
        }
      />
      <div className="px-4 pb-4">
        {!contacts.data?.items.length ? (
          <p className="text-[13px] text-ink-4">{t("contacts.empty")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {contacts.data.items.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2 text-[13px]">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{c.name}</p>
                  <p className="truncate text-xs text-ink-3">{[t(`contacts.kind.${c.kind}`), c.title, c.email].filter(Boolean).join(" · ")}</p>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={t("actions.edit")} onClick={() => setEditing(c)}>
                  <Pencil />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={t("actions.delete")} onClick={() => setDeleting(c.id)}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing?.id ? t("actions.edit") : t("contacts.add")} size="md">
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (editing?.name) save.mutate(editing);
            }}
          >
            {field("name", t("contacts.name"))}
            <Field label={t("contacts.kindLabel")} htmlFor="ct-kind">
              <NativeSelect id="ct-kind" value={editing?.kind ?? "other"} onChange={(e) => setEditing((c) => ({ ...c, kind: e.target.value }))}>
                {CONTACT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`contacts.kind.${k}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {field("title", t("contacts.titleLabel"))}
            {field("email", t("contacts.email"), "email")}
            {field("phone", t("contacts.phone"), "tel")}
            {field("linkedin_url", t("contacts.linkedin"), "url")}
            <Field label={t("common.notes")} htmlFor="ct-notes" className="sm:col-span-2">
              <Textarea id="ct-notes" rows={2} value={editing?.notes ?? ""} onChange={(e) => setEditing((c) => ({ ...c, notes: e.target.value }))} />
            </Field>
            <DialogFooter className="sm:col-span-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={save.isPending}>
                {t("actions.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t("common.confirmDeleteTitle")} body={t("common.confirmDeleteBody")} onConfirm={() => deleting && del.mutate(deleting)} />
    </Card>
  );
}

type ImportReport = { will_import: { jobs: number; skipped_duplicates: number }; warnings: string[]; duplicates: { company: string; title: string }[]; imported?: Record<string, number> };

function DataSection() {
  const { t } = useTranslation();
  const onError = useToastError();
  const invalidate = useInvalidateJobs();
  const [file, setFile] = React.useState<unknown>(null);
  const [report, setReport] = React.useState<ImportReport | null>(null);
  const preview = useMutation({ mutationFn: (data: unknown) => api.post<ImportReport>("/api/import", { mode: "preview", data }), onSuccess: setReport, onError });
  const commit = useMutation({
    mutationFn: () => api.post<ImportReport>("/api/import", { mode: "commit", data: file }),
    onSuccess: () => {
      toast.success(t("settings.data.imported"));
      setReport(null);
      setFile(null);
      void invalidate();
    },
    onError,
  });
  const exportJson = async () => {
    try {
      downloadBlob(await api.download("/api/export/json"), `career-atlas-export-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) {
      onError(e);
    }
  };
  const exportCsv = async () => {
    try {
      const headers = Object.fromEntries(Object.keys(t("export.columns", { returnObjects: true }) as Record<string, string>).map((k) => [k, t(`export.columns.${k}`)]));
      const status_labels = Object.fromEntries(Object.keys(t("status", { returnObjects: true }) as Record<string, string>).map((k) => [k, t(`status.${k}`)]));
      downloadBlob(await api.download("/api/export/csv", { method: "POST", body: { headers, status_labels } }), `career-atlas-jobs-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      onError(e);
    }
  };
  return (
    <Card id="data">
      <CardHeader title={t("settings.sections.data")} description={t("settings.data.backupNote")} />
      <div className="grid gap-4 px-4 pb-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Button onClick={exportJson}>
            <FileJson />
            {t("settings.data.exportJson")}
          </Button>
          <p className="text-xs text-ink-3">{t("settings.data.exportJsonHelp")}</p>
        </div>
        <div className="space-y-2">
          <Button onClick={exportCsv}>
            <Download />
            {t("settings.data.exportCsv")}
          </Button>
          <p className="text-xs text-ink-3">{t("settings.data.exportCsvHelp")}</p>
        </div>
        <div className="space-y-2">
          <label className="inline-flex">
            <span className="sr-only">{t("settings.data.chooseFile")}</span>
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              id="import-file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  const data = JSON.parse(await f.text());
                  setFile(data);
                  preview.mutate(data);
                } catch {
                  toast.error(t("settings.data.invalidFile"));
                }
              }}
            />
            <Button asChild>
              <label htmlFor="import-file" className="cursor-pointer">
                <Upload />
                {t("settings.data.importJson")}
              </label>
            </Button>
          </label>
          <p className="text-xs text-ink-3">{t("settings.data.importHelp")}</p>
        </div>
      </div>
      <Dialog open={!!report} onOpenChange={(o) => !o && setReport(null)}>
        <DialogContent title={t("settings.data.previewTitle")} size="md">
          {report ? (
            <div className="space-y-2 text-[13px]">
              <p>{t("settings.data.willImport", { count: report.will_import.jobs })}</p>
              <p className="text-ink-3">{t("settings.data.willSkip", { count: report.will_import.skipped_duplicates })}</p>
              {report.duplicates.length ? (
                <ul className="max-h-40 overflow-y-auto rounded-md bg-subtle px-3 py-2 text-xs text-ink-3">
                  {report.duplicates.slice(0, 30).map((d, i) => (
                    <li key={i}>
                      {d.company} — {d.title}
                    </li>
                  ))}
                </ul>
              ) : null}
              {report.warnings.includes("documents_metadata_only") ? <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">{t("settings.data.docsWarning")}</p> : null}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setReport(null)}>
                  {t("actions.cancel")}
                </Button>
                <Button variant="primary" disabled={commit.isPending || report.will_import.jobs === 0} onClick={() => commit.mutate()}>
                  {t("settings.data.confirmImport")}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function SystemSection() {
  const { t, me } = useLocaleContext();
  if (!me) return null;
  const c = me.config;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-3 border-b border-line/60 py-1.5 text-[13px] last:border-0">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
  return (
    <Card id="system">
      <CardHeader title={t("settings.sections.system")} />
      <div className="grid gap-6 px-4 pb-4 sm:grid-cols-2">
        <dl>
          {row(t("settings.system.signedInAs"), me.user.email)}
          {row(t("settings.system.environment"), c.app_env)}
          {row(t("settings.system.auth"), c.auth_mode)}
          {row(t("settings.system.ai"), c.ai_enabled ? t("settings.system.aiOn", { provider: c.ai_provider }) : t("settings.system.aiOff"))}
          {row(t("settings.system.storage"), c.uploads_enabled ? t("settings.system.storageOn") : t("settings.system.storageOff"))}
          {row(t("settings.system.queue"), c.queue_enabled ? t("settings.system.queueOn") : t("settings.system.queueOff"))}
        </dl>
        <div>
          <p className="mb-1 text-xs font-medium text-ink-3">{t("settings.system.shortcuts")}</p>
          <ShortcutList />
        </div>
      </div>
    </Card>
  );
}
