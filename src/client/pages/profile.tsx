// My Profile: the personal background used to match jobs. Stored only in the local database,
// saved automatically. "Not specified" is always allowed and never treated as "no".
import { AUTH_STATUSES, CERT_STATUSES, EDUCATION_LEVELS, LANGUAGE_LEVELS, type Profile, type ProfileDTO } from "@shared/profile";
import { parseAiReply, profileImportPrompt } from "@shared/ai-import-prompt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCopy, Plus, Sparkles, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { toast } from "sonner";
import { DocumentSelect } from "@/components/jobs/detail-parts";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Card, CardHeader, Checkbox } from "@/components/ui/misc";
import { TagInput } from "@/components/ui/tag-input";
import { useToastError } from "@/hooks/useApiError";
import { api } from "@/lib/api";
import { setDirty } from "@/lib/save-state";
import { PageFallback, PageHeader } from "./system";

type Tri = "yes" | "no" | "unknown";
const toTri = (v: boolean | null | undefined): Tri => (v === true ? "yes" : v === false ? "no" : "unknown");
const fromTri = (v: string): boolean | null => (v === "yes" ? true : v === "no" ? false : null);

export default function ProfilePage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["profile"], queryFn: () => api.get<ProfileDTO>("/api/profile") });
  if (!q.data) return <PageFallback />;
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title={t("profile.title")} subtitle={t("profile.subtitle")} />
      <ProfileDraftPanel dto={q.data} />
      <ProfileEditor dto={q.data} />
    </div>
  );
}

function useSaveProfile() {
  const qc = useQueryClient();
  const onError = useToastError();
  return useMutation({
    mutationFn: (body: { profile: Profile; resume_document_id?: string | null }) => api.put<ProfileDTO>("/api/profile", body),
    onSuccess: (dto) => {
      qc.setQueryData(["profile"], dto);
      // Match results everywhere depend on the profile.
      void qc.invalidateQueries({ queryKey: ["match"] });
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["compare"] });
    },
    onError,
  });
}

function ProfileEditor({ dto }: { dto: ProfileDTO }) {
  const { t } = useTranslation();
  const save = useSaveProfile();
  const [p, setP] = React.useState<Profile>(dto.profile);
  const saved = React.useRef(JSON.stringify(dto.profile));
  // Adopt server changes (e.g. after accepting a resume draft).
  React.useEffect(() => {
    const incoming = JSON.stringify(dto.profile);
    if (incoming !== saved.current) {
      saved.current = incoming;
      setP(dto.profile);
    }
  }, [dto.profile]);
  // Autosave ~1 s after the last change.
  React.useEffect(() => {
    const json = JSON.stringify(p);
    if (json === saved.current) return;
    setDirty("profile", true);
    const timer = setTimeout(() => {
      saved.current = json;
      save.mutate({ profile: p });
      setDirty("profile", false);
    }, 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);
  React.useEffect(() => () => setDirty("profile", false), []);

  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((s) => ({ ...s, [k]: v }));
  const upd = <K extends keyof Profile>(k: K, i: number, patch: Partial<Profile[K] extends (infer E)[] ? E : never>) =>
    setP((s) => ({ ...s, [k]: (s[k] as unknown[]).map((x, j) => (j === i ? { ...(x as object), ...patch } : x)) }));
  const del = <K extends keyof Profile>(k: K, i: number) => setP((s) => ({ ...s, [k]: (s[k] as unknown[]).filter((_, j) => j !== i) }));
  const add = <K extends keyof Profile>(k: K, item: unknown) => setP((s) => ({ ...s, [k]: [...(s[k] as unknown[]), item] }));
  const sel = (id: string, value: string, onChange: (v: string) => void, options: readonly string[], prefix: string, label: string) => (
    <NativeSelect id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {t(`${prefix}.${o}`)}
        </option>
      ))}
    </NativeSelect>
  );
  const removeBtn = (onClick: () => void) => (
    <Button variant="ghost" size="icon-sm" aria-label={t("actions.delete")} onClick={onClick}>
      <Trash2 />
    </Button>
  );
  const addBtn = (onClick: () => void) => (
    <Button variant="secondary" size="sm" onClick={onClick}>
      <Plus />
      {t("profile.add")}
    </Button>
  );

  return (
    <>
      <Card>
        <CardHeader title={t("profile.sections.resume")} description={t("profile.resumeHelp")} />
        <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
          <Field label={t("profile.resumeFile")} htmlFor="pf-resume" hint={<Link to="/documents" className="text-accent underline">{t("profile.uploadInDocuments")}</Link>}>
            <DocumentSelect id="pf-resume" kind="resume" label={t("profile.resumeFile")} value={dto.resume_document_id} onChange={(v) => save.mutate({ profile: p, resume_document_id: v })} />
          </Field>
          <ProfileAiImport />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("profile.sections.eligibility")} description={t("profile.unknownNote")} />
        <div className="space-y-4 px-4 pb-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(["city", "region", "country"] as const).map((k) => (
              <Field key={k} label={t(`profile.basedIn.${k}`)} htmlFor={`pf-${k}`}>
                <Input id={`pf-${k}`} value={p.based_in[k] ?? ""} onChange={(e) => set("based_in", { ...p.based_in, [k]: e.target.value || null })} />
              </Field>
            ))}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-3">{t("profile.workAuthorization")}</p>
            <div className="space-y-2">
              {p.work_authorization.map((w, i) => (
                <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <Input aria-label={t("profile.country")} placeholder={t("profile.country")} value={w.country} onChange={(e) => upd("work_authorization", i, { country: e.target.value })} />
                  {sel(`pf-auth-${i}`, w.status, (v) => upd("work_authorization", i, { status: v as (typeof AUTH_STATUSES)[number] }), AUTH_STATUSES, "profile.authStatus", t("profile.status"))}
                  <Input aria-label={t("profile.note")} placeholder={t("profile.note")} value={w.note ?? ""} onChange={(e) => upd("work_authorization", i, { note: e.target.value || null })} />
                  {removeBtn(() => del("work_authorization", i))}
                </div>
              ))}
              {addBtn(() => add("work_authorization", { country: p.based_in.country ?? "", status: "citizen", note: null }))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label={t("profile.licence.has")} htmlFor="pf-dl">
              {sel("pf-dl", toTri(p.driver_licence.has), (v) => set("driver_licence", { ...p.driver_licence, has: fromTri(v) }), ["unknown", "yes", "no"], "profile.tri", t("profile.licence.has"))}
            </Field>
            <Field label={t("profile.licence.type")} htmlFor="pf-dl-type">
              <Input id="pf-dl-type" value={p.driver_licence.type ?? ""} placeholder="G, G2, Class 5…" onChange={(e) => set("driver_licence", { ...p.driver_licence, type: e.target.value || null })} />
            </Field>
            <Field label={t("profile.licence.jurisdiction")} htmlFor="pf-dl-j">
              <Input id="pf-dl-j" value={p.driver_licence.jurisdiction ?? ""} onChange={(e) => set("driver_licence", { ...p.driver_licence, jurisdiction: e.target.value || null })} />
            </Field>
            <Field label={t("profile.licence.vehicle")} htmlFor="pf-veh">
              {sel("pf-veh", toTri(p.driver_licence.has_vehicle), (v) => set("driver_licence", { ...p.driver_licence, has_vehicle: fromTri(v) }), ["unknown", "yes", "no"], "profile.tri", t("profile.licence.vehicle"))}
            </Field>
          </div>
          <Field label={t("profile.clearance")} htmlFor="pf-clear" hint={t("profile.clearanceHint")}>
            <Input id="pf-clear" value={p.security_clearance ?? ""} onChange={(e) => set("security_clearance", e.target.value || null)} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("profile.sections.languages")} />
        <div className="space-y-2 px-4 pb-4">
          {p.languages.map((l, i) => (
            <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input aria-label={t("profile.language")} placeholder={t("profile.language")} value={l.language} onChange={(e) => upd("languages", i, { language: e.target.value })} />
              {sel(`pf-lang-${i}`, l.level, (v) => upd("languages", i, { level: v as (typeof LANGUAGE_LEVELS)[number] }), LANGUAGE_LEVELS, "profile.languageLevel", t("profile.level"))}
              {removeBtn(() => del("languages", i))}
            </div>
          ))}
          {addBtn(() => add("languages", { language: "", level: "professional" }))}
        </div>
      </Card>

      <Card>
        <CardHeader title={t("profile.sections.education")} />
        <div className="space-y-3 px-4 pb-4">
          {p.education.map((e, i) => (
            <div key={i} className="grid items-end gap-2 rounded-md border border-line p-2 sm:grid-cols-3">
              {sel(`pf-edu-${i}`, e.level, (v) => upd("education", i, { level: v as (typeof EDUCATION_LEVELS)[number] }), EDUCATION_LEVELS, "profile.educationLevel", t("profile.level"))}
              <Input aria-label={t("profile.fieldOfStudy")} placeholder={t("profile.fieldOfStudy")} value={e.field ?? ""} onChange={(x) => upd("education", i, { field: x.target.value || null })} />
              <Input aria-label={t("profile.institution")} placeholder={t("profile.institution")} value={e.institution ?? ""} onChange={(x) => upd("education", i, { institution: x.target.value || null })} />
              <Input aria-label={t("profile.country")} placeholder={t("profile.country")} value={e.country ?? ""} onChange={(x) => upd("education", i, { country: x.target.value || null })} />
              {sel(`pf-edu-done-${i}`, e.completed === false ? "no" : e.completed == null ? "unknown" : "yes", (v) => upd("education", i, { completed: fromTri(v) }), ["yes", "no", "unknown"], "profile.completed", t("profile.completedLabel"))}
              <div className="flex items-center gap-2">
                <Input aria-label={t("profile.year")} placeholder={t("profile.year")} inputMode="numeric" value={e.year ?? ""} onChange={(x) => upd("education", i, { year: x.target.value ? Number(x.target.value) || null : null })} />
                {removeBtn(() => del("education", i))}
              </div>
            </div>
          ))}
          {addBtn(() => add("education", { level: "bachelor", field: null, institution: null, country: null, completed: true, year: null }))}
        </div>
      </Card>

      <Card>
        <CardHeader title={t("profile.sections.experience")} description={t("profile.experienceHelp")} />
        <div className="space-y-3 px-4 pb-4">
          {p.experience.map((e, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line p-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input aria-label={t("profile.jobTitle")} placeholder={t("profile.jobTitle")} value={e.title} onChange={(x) => upd("experience", i, { title: x.target.value })} />
                <Input aria-label={t("profile.organization")} placeholder={t("profile.organization")} value={e.organization ?? ""} onChange={(x) => upd("experience", i, { organization: x.target.value || null })} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <Input className="w-36" type="month" aria-label={t("profile.start")} value={e.start ?? ""} onChange={(x) => upd("experience", i, { start: x.target.value || null })} />
                <span className="text-ink-4">–</span>
                <Input className="w-36" type="month" aria-label={t("profile.end")} disabled={e.current} value={e.end ?? ""} onChange={(x) => upd("experience", i, { end: x.target.value || null })} />
                <label className="flex items-center gap-1.5">
                  <Checkbox checked={e.current} onCheckedChange={(v) => upd("experience", i, { current: !!v, end: v ? null : e.end })} />
                  {t("profile.current")}
                </label>
                <span className="ml-auto">{removeBtn(() => del("experience", i))}</span>
              </div>
              <TagInput value={e.areas} onChange={(v) => upd("experience", i, { areas: v })} placeholder={t("profile.areasPlaceholder")} />
              <Textarea rows={2} aria-label={t("profile.description")} placeholder={t("profile.description")} value={e.description ?? ""} onChange={(x) => upd("experience", i, { description: x.target.value || null })} />
            </div>
          ))}
          {addBtn(() => add("experience", { title: "", organization: null, start: null, end: null, current: false, areas: [], description: null }))}
          <div className="pt-2">
            <p className="mb-1 text-xs font-medium text-ink-3">{t("profile.experienceSummary")}</p>
            <div className="space-y-2">
              {p.experience_summary.map((s, i) => (
                <div key={i} className="grid items-end gap-2 sm:grid-cols-[2fr_1fr_auto]">
                  <Input aria-label={t("profile.area")} placeholder={t("profile.area")} value={s.area} onChange={(x) => upd("experience_summary", i, { area: x.target.value })} />
                  <Input aria-label={t("profile.years")} type="number" min={0} step={0.5} value={s.years} onChange={(x) => upd("experience_summary", i, { years: Number(x.target.value) || 0 })} />
                  {removeBtn(() => del("experience_summary", i))}
                </div>
              ))}
              {addBtn(() => add("experience_summary", { area: "", years: 1 }))}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("profile.sections.skills")} />
        <div className="space-y-4 px-4 pb-4">
          <TagInput value={p.skills} onChange={(v) => set("skills", v)} placeholder={t("profile.skillsPlaceholder")} max={200} />
          <div>
            <p className="mb-1 text-xs font-medium text-ink-3">{t("profile.certifications")}</p>
            <div className="space-y-2">
              {p.certifications.map((c, i) => (
                <div key={i} className="grid items-end gap-2 sm:grid-cols-[2fr_1fr_auto]">
                  <Input aria-label={t("profile.certName")} placeholder={t("profile.certName")} value={c.name} onChange={(x) => upd("certifications", i, { name: x.target.value })} />
                  {sel(`pf-cert-${i}`, c.status, (v) => upd("certifications", i, { status: v as (typeof CERT_STATUSES)[number] }), CERT_STATUSES, "profile.certStatus", t("profile.status"))}
                  {removeBtn(() => del("certifications", i))}
                </div>
              ))}
              {addBtn(() => add("certifications", { name: "", status: "held" }))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-3">{t("profile.projects")}</p>
            <div className="space-y-2">
              {p.projects.map((x, i) => (
                <div key={i} className="space-y-2 rounded-md border border-line p-2">
                  <div className="flex items-center gap-2">
                    <Input aria-label={t("profile.projectName")} placeholder={t("profile.projectName")} value={x.name} onChange={(e) => upd("projects", i, { name: e.target.value })} />
                    {removeBtn(() => del("projects", i))}
                  </div>
                  <Textarea rows={2} aria-label={t("profile.description")} placeholder={t("profile.description")} value={x.description ?? ""} onChange={(e) => upd("projects", i, { description: e.target.value || null })} />
                  <TagInput value={x.skills} onChange={(v) => upd("projects", i, { skills: v })} placeholder={t("profile.skillsPlaceholder")} />
                </div>
              ))}
              {addBtn(() => add("projects", { name: "", description: null, skills: [] }))}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t("profile.sections.notes")} />
        <div className="px-4 pb-4">
          <Textarea rows={3} aria-label={t("profile.sections.notes")} value={p.notes ?? ""} onChange={(e) => set("notes", e.target.value || null)} />
        </div>
      </Card>
    </>
  );
}

/** Paste an AI's answer (ChatGPT, Claude, …) to create a profile draft; or use the Claude Desktop extension. */
function ProfileAiImport() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onError = useToastError();
  const [text, setText] = React.useState("");
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post("/api/profile/drafts", { ...body, origin: "paste" }),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["profile"] });
      toast.success(t("profile.draft.created"));
    },
    onError,
  });
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-3">{t("profile.claudeHelp")}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(profileImportPrompt());
            toast.success(t("profile.promptCopied"));
          } catch {
            toast.error(t("drafts.import.copyFailed"));
          }
        }}
      >
        <ClipboardCopy />
        {t("profile.copyPrompt")}
      </Button>
      <Textarea rows={3} className="font-mono text-xs" aria-label={t("profile.aiAnswer")} placeholder={t("profile.aiAnswer")} value={text} onChange={(e) => setText(e.target.value)} />
      <Button
        size="sm"
        variant="primary"
        disabled={!text.trim() || create.isPending}
        onClick={() => {
          const parsed = parseAiReply(text);
          if (!parsed || !Array.isArray((parsed as { items?: unknown }).items)) return toast.error(t("profile.unreadable"));
          create.mutate(parsed);
        }}
      >
        {t("profile.createDraft")}
      </Button>
    </div>
  );
}

/** Review facts proposed from a resume; only checked items are added to the profile. */
function ProfileDraftPanel({ dto }: { dto: ProfileDTO }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onError = useToastError();
  const draft = dto.draft;
  const [chosen, setChosen] = React.useState<Set<string>>(() => new Set(draft?.items.filter((i) => i.verified).map((i) => i.id) ?? []));
  React.useEffect(() => setChosen(new Set(draft?.items.filter((i) => i.verified).map((i) => i.id) ?? [])), [draft?.created_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const after = (next: ProfileDTO) => {
    qc.setQueryData(["profile"], next);
    void qc.invalidateQueries({ queryKey: ["match"] });
    void qc.invalidateQueries({ queryKey: ["jobs"] });
  };
  const accept = useMutation({ mutationFn: () => api.post<ProfileDTO>("/api/profile/drafts/accept", { item_ids: [...chosen] }), onSuccess: (d) => (after(d), toast.success(t("profile.draft.accepted"))), onError });
  const discard = useMutation({ mutationFn: () => api.post("/api/profile/drafts/discard"), onSuccess: () => void qc.invalidateQueries({ queryKey: ["profile"] }), onError });
  if (!draft) return null;
  const show = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== "" && !(Array.isArray(x) && !x.length)).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(", ") : String(x)}`).join(" · "));
  return (
    <Card className="border-violet/30">
      <CardHeader title={<span className="flex items-center gap-1.5"><Sparkles className="size-4 text-violet" />{t("profile.draft.title")}</span>} description={t("profile.draft.intro")} />
      <div className="space-y-2 px-4 pb-4">
        {draft.notes ? <p className="rounded-md bg-subtle px-3 py-2 text-xs text-ink-2">{draft.notes}</p> : null}
        {draft.dropped.length ? <p className="text-xs text-warn">{t("profile.draft.dropped", { sections: [...new Set(draft.dropped.map((d) => t(`profile.sectionNames.${d.section}`, { defaultValue: d.section })))].join(", ") })}</p> : null}
        <ul className="divide-y divide-line rounded-md border border-line">
          {draft.items.map((it) => (
            <li key={it.id} className="flex items-start gap-3 px-3 py-2 text-[13px]">
              <Checkbox className="mt-0.5" aria-label={show(it.value)} checked={chosen.has(it.id)} onCheckedChange={(v) => setChosen((s) => { const n = new Set(s); if (v) n.add(it.id); else n.delete(it.id); return n; })} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-ink-3">{t(`profile.sectionNames.${it.section}`)}</span>
                  {it.verified ? <Badge tone="ok"><CheckCircle2 />{t("profile.draft.verified")}</Badge> : <Badge tone="warn">{t("profile.draft.unverified")}</Badge>}
                </div>
                <p className="break-words text-ink">{show(it.value)}</p>
                {it.evidence ? <p className="text-xs text-ink-4">“{it.evidence}”</p> : null}
              </div>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => discard.mutate()} disabled={discard.isPending}>
            {t("actions.dismiss")}
          </Button>
          <Button variant="primary" onClick={() => accept.mutate()} disabled={accept.isPending || chosen.size === 0}>
            {t("profile.draft.addSelected", { count: chosen.size })}
          </Button>
        </div>
      </div>
    </Card>
  );
}
