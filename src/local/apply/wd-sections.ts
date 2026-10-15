// Workday repeatable sections and tag boxes, filled from My Profile:
//   Work Experience · Education · Websites · Languages · Skills · "How did you hear about us?"
//
// Each section is handled as a unit (not as loose text fields):
//   observe the section → match existing panels (resume parsing, a saved draft) to profile entries →
//   reuse an empty panel or click THIS section's Add → fill each control by its role in the panel →
//   save the panel when the tenant has a Save button → re-read and verify every value.
// Controls are found again before every action (React re-renders replace nodes). An option is chosen
// only when it means the same as the applicant's data (src/shared/apply-match.ts); otherwise a
// required field becomes a question and an optional one is recorded as skipped — never guessed.
// Optional, unavailable skills never block the application.
import type { FilledField, PendingQuestion } from "@shared/apply";
import {
  fieldQueries,
  formUrl,
  matchDegree,
  matchFieldOfStudy,
  matchLanguage,
  matchProficiency,
  matchSchool,
  matchSkill,
  matchSource,
  mnorm,
  sameSchool,
  schoolQueries,
  SOURCE_QUERY,
  urlKey,
  type JobSource,
} from "@shared/apply-match";
import { questionMeaning } from "@shared/apply-semantic";
import type { Profile } from "@shared/profile";
import type { Page } from "playwright-core";
import { browseSelect, checkSet, dateSet, listSelect, locate, scan, searchSelect, textSet, valuesOf, type Finder, type PickResult } from "./interact";
import { fieldKey, norm, question, type FieldDescriptor } from "./plan";
import { addButton, deletePanel, savePanel } from "./workday";

type Group = "work" | "education" | "websites" | "languages";

export interface SectionCtx {
  page: Page;
  profile: Profile;
  answers: Record<string, unknown>;
  employer: string | null;
  jobSource: JobSource;
  /** Throws to stop (cancelled / the page moved on). */
  guard: () => Promise<void>;
  record: (f: FilledField) => void;
  event: (code: string, params?: Record<string, string | number>) => Promise<void>;
  /** Local diagnostic snapshot of a section that could not be completed (structure only). */
  diag: (section: string, fields: FieldDescriptor[], note: string) => Promise<void>;
  /** Optional (owner opt-in): does one of `options` mean the same as `value`? Never used for facts. */
  equivalent?: (purpose: "skill" | "field_of_study" | "language" | "school", value: string, options: string[]) => Promise<string | null>;
}

export interface SectionResult {
  questions: PendingQuestion[];
  /** Field keys completed here (the generic planner leaves them alone). */
  handled: Set<string>;
}

const SECTION_RE: Record<Group, RegExp> = { work: /work experience|experience|employment/, education: /education/, websites: /web ?sites?|links?|urls?|social network/, languages: /languages?/ };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- field roles inside a panel

type Role =
  | "jobTitle" | "company" | "location" | "current" | "start" | "end" | "description"
  | "school" | "degree" | "field" | "from" | "to" | "gpa"
  | "url" | "urlType"
  | "language" | "fluent" | "proficiency"
  | "other";

export function roleOf(group: Group, f: FieldDescriptor): Role {
  const w = (f.wdField ?? "").toLowerCase();
  const l = norm(f.label);
  if (group === "work") {
    if (w === "jobtitle" || /^(job )?title|position/.test(l)) return "jobTitle";
    if (w === "companyname" || w === "company" || /^(company|employer|organi[sz]ation)/.test(l)) return "company";
    if (w === "currentlyworkhere" || /currently work/.test(l)) return "current";
    if (w === "startdate" || /^(from|start)/.test(l)) return "start";
    if (w === "enddate" || /^(to|end)\b/.test(l)) return "end";
    if (w === "roledescription" || w === "description" || /description|responsibilit/.test(l)) return "description";
    if (w === "location" || /^location/.test(l)) return "location";
    return "other";
  }
  if (group === "education") {
    if (w === "schoolname" || w === "school" || /school|university|institution|college/.test(l)) return "school";
    if (w === "degree" || /^degree|qualification/.test(l)) return "degree";
    if (w === "fieldofstudy" || /field of study|major|discipline|programme|program of study/.test(l)) return "field";
    if (w === "firstyearattended" || w === "startdate" || /^from|start/.test(l)) return "from";
    if (w === "lastyearattended" || w === "enddate" || /^to\b|end|graduat|expected/.test(l)) return "to";
    if (/gpa|grade|average/.test(`${w} ${l}`)) return "gpa";
    return "other";
  }
  if (group === "websites") {
    if (/type|category|kind/.test(l) && f.control !== "text") return "urlType";
    if (w === "url" || f.control === "text" || /url|web ?site|address|link/.test(l)) return "url";
    return "other";
  }
  if (w === "language" || /^language$|^language name/.test(l)) return "language";
  if (f.control === "checkbox" && /fluent|native|mother tongue|first language/.test(l)) return "fluent";
  if (["listbox", "select", "combobox", "radio"].includes(f.control)) return f.control === "combobox" && /language/.test(l) ? "language" : "proficiency";
  return "other";
}

const panelsOf = (fields: FieldDescriptor[], group: Group) => {
  const m = new Map<number, FieldDescriptor[]>();
  for (const f of fields) if (f.visible && f.group === group && f.groupIndex != null && f.groupIndex >= 0) m.set(f.groupIndex, [...(m.get(f.groupIndex) ?? []), f]);
  return m;
};
const pick = (ds: FieldDescriptor[], group: Group, role: Role) => ds.find((d) => roleOf(group, d) === role);
const shown = (f: FieldDescriptor | undefined) => valuesOf(f).join(", ");

export async function fillSections(ctx: SectionCtx): Promise<SectionResult> {
  const out: SectionResult = { questions: [], handled: new Set() };
  const { page } = ctx;
  const ask = (q: PendingQuestion) => {
    if (!out.questions.some((x) => x.key === q.key)) out.questions.push(q);
  };
  const finder = (group: Group, index: number, role: Role): Finder => () => locate(page, (f) => f.group === group && f.groupIndex === index && roleOf(group, f) === role);
  const answer = (key: string) => {
    const a = ctx.answers[key];
    return a === undefined || a === null || a === "" ? undefined : a;
  };
  const ok = (label: string, source: string, status: FilledField["status"] = "filled") => ctx.record({ label: label.slice(0, 300), source, verified: true, status });
  const fail = (label: string, source: string) => ctx.record({ label: label.slice(0, 300), source, verified: false });
  const skipped = (label: string, source: string, why: string) => ctx.record({ label: label.slice(0, 300), source, verified: false, status: "skipped", value: why.slice(0, 300) });

  /** Adds a panel with THIS section's Add button; returns its position or null. */
  const addPanel = async (group: Group): Promise<number | null> => {
    const before = panelsOf(await scan(page), group).size;
    const btn = await addButton(page, SECTION_RE[group]);
    if (!btn) return null;
    await btn.click({ timeout: 5000 }).catch(() => btn.click({ force: true, timeout: 5000 }).catch(() => {}));
    for (let w = 0; w < 25; w++) {
      const now = panelsOf(await scan(page), group);
      if (now.size > before) {
        await ctx.event(`${group === "work" ? "work_entry" : group === "education" ? "education_entry" : group === "websites" ? "website" : "language"}_added`, { n: now.size });
        return Math.max(...now.keys());
      }
      await sleep(200);
    }
    return null;
  };
  const commitPanel = async (group: Group, index: number) => {
    const ds = panelsOf(await scan(page), group).get(index) ?? [];
    if (ds.length) await savePanel(page, ds.map((d) => d.ref));
  };

  // Choose by the control's kind: listbox / select / radio → list; searchable prompt → search; text → type.
  const choose = async (find: Finder, f: FieldDescriptor, queries: string[], decide: (labels: string[]) => string | null, committed?: (f: FieldDescriptor, p: string) => boolean): Promise<PickResult> => {
    const isOk = committed ?? ((x: FieldDescriptor, p: string) => valuesOf(x).some((v) => norm(v) === norm(p)));
    if (f.control === "combobox") return searchSelect(page, find, { queries, choose: (labels) => decide(labels), committed: isOk, guard: ctx.guard });
    return listSelect(page, find, decide, isOk);
  };

  await ctx.guard();
  if (ctx.profile.experience.length) await work();
  await ctx.guard();
  if (ctx.profile.education.length) await education();
  await ctx.guard();
  await websites();
  await ctx.guard();
  if (ctx.profile.languages.length) await languages();
  await ctx.guard();
  await skills();
  await ctx.guard();
  await source();
  await finalCheck();
  return out;

  /**
   * End of the page: every required control in the repeatable sections must still hold a value
   * (a site may drop a value after a later re-render). Anything empty is reported, never assumed done.
   */
  async function finalCheck() {
    const groups: Group[] = ["work", "education", "websites", "languages"];
    for (const f of await scan(page)) {
      if (!f.visible || !f.required || !f.group || !groups.includes(f.group as Group) || f.control === "file") continue;
      if (valuesOf(f).length || f.value === true) continue;
      const key = `${f.group}:${f.groupIndex}:${f.wdField || norm(f.label)}`.slice(0, 200);
      ask({ ...question(f, key, "not_accepted", false), label: `${f.group === "work" ? "Work experience" : f.group === "education" ? "Education" : f.group === "websites" ? "Websites" : "Languages"} ${(f.groupIndex ?? 0) + 1}: ${f.label}`.slice(0, 500) });
    }
  }

  // ============================================================ work experience
  async function work() {
    const entries = ctx.profile.experience;
    let fields = await scan(page);
    if (!fields.some((f) => f.group === "work") && !(await addButton(page, SECTION_RE.work))) return;
    const assigned = await matchPanels("work", entries.map((e) => ({ first: e.title, second: e.organization ?? "" })), (ds) => [shown(pick(ds, "work", "jobTitle")), shown(pick(ds, "work", "company"))]);
    for (let k = 0; k < entries.length; k++) {
      await ctx.guard();
      const e = entries[k];
      let pi = assigned.get(k);
      if (pi === undefined) {
        const free = await emptyPanel("work", "jobTitle", assigned);
        pi = free ?? (await addPanel("work")) ?? undefined;
        if (pi === undefined) {
          fail(`${e.title}: work experience`, "experience");
          break;
        }
        assigned.set(k, pi);
      }
      const tag = `${e.title}${e.organization ? ` — ${e.organization}` : ""}`;
      const ds = panelsOf(await scan(page), "work").get(pi) ?? [];
      const ym = (s: string | null | undefined) => (s ? { year: s.slice(0, 4), month: s.length >= 7 ? s.slice(5, 7) : undefined } : null);
      const steps: [Role, string | boolean | { year: string; month?: string } | null][] = [
        ["jobTitle", e.title],
        ["company", e.organization ?? null],
        ["current", e.current],
        ["start", ym(e.start)],
        ["end", e.current ? null : ym(e.end)],
        ["description", e.description ?? null],
      ];
      for (const [role, raw] of steps) {
        await ctx.guard();
        const f = pick((panelsOf(await scan(page), "work").get(pi) ?? ds), "work", role);
        if (!f) continue;
        const key = `work:${k}:${f.wdField || role}`;
        const v = answer(key) ?? raw;
        const label = `${tag}: ${f.label.replace(/\*\s*$/, "")}`;
        if (v === null || v === undefined || v === "") {
          if (f.required && !shown(f)) ask({ ...question(f, key, "missing", false), label: label.slice(0, 500) });
          continue;
        }
        // A description the site already has (resume parsing) is kept: richer text is not "wrong".
        if (role === "description" && shown(f)) {
          ok(label, "site", "kept");
          continue;
        }
        const before = shown(f);
        const find = finder("work", pi, role);
        const done =
          f.control === "checkbox" ? await checkSet(page, find, v === true) : f.control === "date" && typeof v === "object" ? await dateSet(page, find, v as { year: string; month?: string }) : await textSet(page, find, String(v));
        if (done) ok(label, role === "description" ? "experience.description" : "experience", before && f.control !== "checkbox" && norm(before) !== norm(typeof v === "object" ? "" : String(v)) ? "corrected" : before ? "kept" : "filled");
        else {
          fail(label, "experience");
          if (f.required) ask({ ...question(f, key, "not_accepted", false), label: label.slice(0, 500) });
        }
      }
      await commitPanel("work", pi);
    }
    await extras("work", assigned, (ds) => [shown(pick(ds, "work", "jobTitle")), shown(pick(ds, "work", "company"))]);
  }

  // ============================================================ education (each school its own degree and field)
  async function education() {
    const entries = ctx.profile.education;
    if (!(await scan(page)).some((f) => f.group === "education") && !(await addButton(page, SECTION_RE.education))) return;
    const assigned = new Map<number, number>();
    const panels = panelsOf(await scan(page), "education");
    const used = new Set<number>();
    for (let k = 0; k < entries.length; k++) {
      const inst = entries[k].institution;
      if (!inst) continue;
      for (const [pi, ds] of [...panels.entries()].sort((a, b) => a[0] - b[0])) {
        if (used.has(pi)) continue;
        const school = shown(pick(ds, "education", "school"));
        if (school && sameSchool(school, inst)) {
          assigned.set(k, pi);
          used.add(pi);
          break;
        }
      }
    }
    for (let k = 0; k < entries.length; k++) {
      await ctx.guard();
      const e = entries[k];
      let pi = assigned.get(k);
      if (pi === undefined) {
        const free = await emptyPanel("education", "school", assigned);
        pi = free ?? (await addPanel("education")) ?? undefined;
        if (pi === undefined) {
          fail(`${e.institution ?? "Education"}: education`, "education");
          break;
        }
        assigned.set(k, pi);
      }
      const tag = e.institution ?? `Education ${k + 1}`;
      const at = async (role: Role) => pick(panelsOf(await scan(page), "education").get(pi!) ?? [], "education", role);
      const keyOf = (f: FieldDescriptor, role: Role) => `education:${k}:${f.wdField || role}`;
      const lbl = (f: FieldDescriptor) => `${tag}: ${f.label.replace(/\*\s*$/, "")}`.slice(0, 500);

      // School
      let f = await at("school");
      if (f && e.institution) {
        const key = keyOf(f, "school");
        const want = String(answer(key) ?? e.institution);
        const before = shown(f);
        let r: PickResult | null = null;
        let good = false;
        if (before && sameSchool(before, want)) good = true;
        else if (f.control === "text" || f.control === "textarea") good = await textSet(page, finder("education", pi, "school"), want);
        else {
          r = await choose(finder("education", pi, "school"), f, schoolQueries(want), (labels) => (answer(key) ? labels.find((l) => norm(l) === norm(want)) ?? null : matchSchool(want, labels).pick), (x, p) => valuesOf(x).some((v) => norm(v) === norm(p) || sameSchool(v, want)));
          good = r.ok;
          if (!good && ctx.equivalent && r.seen.length) {
            const alt = await ctx.equivalent("school", want, r.seen);
            if (alt) good = (await choose(finder("education", pi, "school"), f, [alt], (labels) => labels.find((l) => norm(l) === norm(alt)) ?? null)).ok;
          }
        }
        if (good) ok(lbl(f), "education.institution", before && !sameSchool(before, want) ? "corrected" : before ? "kept" : "filled");
        else {
          fail(lbl(f), "education.institution");
          if (f.required) ask({ ...question(f, key, "no_matching_option", false, want), options: (r?.seen ?? []).slice(0, 100), label: lbl(f) });
        }
      }
      // Degree — from THIS entry's level only.
      f = await at("degree");
      if (f) {
        const key = keyOf(f, "degree");
        const given = answer(key);
        const decide = (labels: string[]) => (given ? labels.find((l) => norm(l) === norm(String(given))) ?? null : matchDegree(e.level, labels).pick);
        const before = shown(f);
        const queries = ({ bachelor: ["Bachelor"], master: ["Master"], doctorate: ["Doctor", "PhD"], diploma: ["Diploma", "Associate"], high_school: ["High School"] } as Record<string, string[]>)[e.level] ?? [];
        const already = before && decide([before]) === before;
        const r = already ? null : await choose(finder("education", pi, "degree"), f, queries, decide);
        if (already || r?.ok) ok(lbl(f), "education.level", already ? "kept" : before ? "corrected" : "filled");
        else {
          fail(lbl(f), "education.level");
          if (f.required) ask({ ...question(f, key, "no_matching_option", false, e.level), options: (r?.seen ?? []).slice(0, 100), label: lbl(f) });
        }
      }
      // Field of study — THIS entry's programme, exact (or its parts in a multi-value box).
      f = await at("field");
      if (f && e.field) await fieldOfStudy(f, k, pi, e.field, lbl(f), keyOf(f, "field"));
      else if (f && f.required && !shown(f)) ask({ ...question(f, keyOf(f, "field"), "missing", false), label: lbl(f) });
      // Dates: only the year this entry records (graduation / expected graduation).
      f = await at("to");
      if (f && e.year) {
        const done = f.control === "date" ? await dateSet(page, finder("education", pi, "to"), { year: String(e.year) }) : await textSet(page, finder("education", pi, "to"), String(e.year));
        if (done) ok(lbl(f), "education.year");
        else fail(lbl(f), "education.year");
      }
      for (const role of ["from", "other", "gpa"] as Role[]) {
        const g = await at(role);
        if (g && g.required && !shown(g)) ask({ ...question(g, keyOf(g, role), "missing", false), label: lbl(g) });
      }
      await commitPanel("education", pi);
      // Re-read: this school must show this entry's degree (never another entry's).
      const ds = panelsOf(await scan(page), "education").get(pi) ?? [];
      const deg = shown(pick(ds, "education", "degree"));
      if (deg && !answer(keyOf(pick(ds, "education", "degree")!, "degree")) && matchDegree(e.level, [deg]).pick !== deg) {
        fail(`${tag}: degree check`, "education.level");
        await ctx.diag("education", ds, "degree_mismatch_after_fill");
      }
    }
    await extras("education", new Map([...assigned].map(([k, p]) => [k, p])), (ds) => [shown(pick(ds, "education", "school")), shown(pick(ds, "education", "degree"))]);
  }

  async function fieldOfStudy(f: FieldDescriptor, k: number, pi: number, field: string, label: string, key: string) {
    const find = finder("education", pi, "field");
    const given = answer(key);
    const want = given ? String(given) : field;
    const has = (x: FieldDescriptor, p: string) => valuesOf(x).some((v) => norm(v) === norm(p));
    const before = valuesOf(f);
    if (before.length && matchFieldOfStudy(want, before, true).picks.every((p) => before.includes(p)) && matchFieldOfStudy(want, before, true).picks.length) {
      ok(label, "education.field", "kept");
      return;
    }
    const multi = f.control === "combobox";
    // 1. the whole programme name (exact option)
    let r = await choose(find, f, [want], (labels) => matchFieldOfStudy(want, labels, false).picks[0] ?? null, has);
    if (!r.ok && ctx.equivalent && r.seen.length && !given) {
      const alt = await ctx.equivalent("field_of_study", want, r.seen);
      if (alt) r = await choose(find, f, [alt], (labels) => labels.find((l) => norm(l) === norm(alt)) ?? null, has);
    }
    // 2. a joint programme: each part, exactly, when the box takes several values
    if (!r.ok && multi && fieldQueries(want).length > 1) {
      const parts = fieldQueries(want).slice(1);
      const picked: string[] = [];
      for (const part of parts) {
        const pr = await choose(find, f, [part], (labels) => labels.find((l) => mnorm(l) === mnorm(part)) ?? null, has);
        if (pr.ok) picked.push(pr.picked[0]);
        else break;
      }
      const now = (await find())?.f;
      r = { ok: picked.length === parts.length && picked.every((p) => now && has(now, p)), picked, seen: r.seen };
    }
    if (r.ok) ok(label, "education.field", before.length ? "corrected" : "filled");
    else {
      fail(label, "education.field");
      if (f.required) ask({ ...question(f, key, "no_matching_option", false, want), options: r.seen.slice(0, 100), label });
      else skipped(label, "education.field", `“${want}” is not offered`);
      void k;
    }
  }

  // ============================================================ websites (one row per URL: Add → type → save → verify)
  async function websites() {
    const c = ctx.profile.contact;
    const urls: { url: string; kind: "linkedin" | "website" | "portfolio" | "github" }[] = [];
    for (const [kind, u] of [["linkedin", c.linkedin_url], ["website", c.website_url], ["portfolio", c.portfolio_url], ["github", c.github_url]] as const) {
      if (u && u.trim() && !urls.some((x) => urlKey(x.url) === urlKey(u))) urls.push({ url: u.trim(), kind });
    }
    if (!urls.length) return;
    const fields = await scan(page);
    const hasSection = fields.some((f) => f.group === "websites") || !!(await addButton(page, SECTION_RE.websites));
    if (!hasSection) return;
    const present = () => scan(page).then((fs) => [...panelsOf(fs, "websites").entries()]);
    for (const { url, kind } of urls) {
      await ctx.guard();
      const label = `Websites: ${kind === "linkedin" ? "LinkedIn" : kind === "github" ? "GitHub" : kind === "portfolio" ? "Portfolio" : "Personal website"}`;
      const rows = await present();
      if (rows.some(([, ds]) => urlKey(shown(pick(ds, "websites", "url"))) === urlKey(url))) {
        ok(label, `contact.${kind}_url`, "kept");
        continue;
      }
      let pi = rows.find(([, ds]) => !shown(pick(ds, "websites", "url")))?.[0];
      if (pi === undefined) pi = (await addPanel("websites")) ?? undefined;
      if (pi === undefined) {
        fail(label, `contact.${kind}_url`);
        await ctx.diag("websites", (await scan(page)).filter((f) => f.group === "websites"), "add_button_not_found");
        break;
      }
      const done = await textSet(page, finder("websites", pi, "url"), formUrl(url));
      const type = pick(panelsOf(await scan(page), "websites").get(pi) ?? [], "websites", "urlType");
      if (type && !shown(type)) {
        const want = kind === "linkedin" ? /linked ?in|social/ : kind === "github" ? /git ?hub|code|other/ : /personal|web ?site|portfolio|blog|other/;
        const r = await choose(finder("websites", pi, "urlType"), type, [kind], (labels) => {
          const hits = labels.filter((l) => want.test(mnorm(l)));
          return hits.length === 1 ? hits[0] : (hits.find((l) => mnorm(l).startsWith(kind)) ?? null);
        });
        if (!r.ok && type.required) ask({ ...question(type, `websites:${pi}:type`, "no_matching_option", false, kind), options: r.seen.slice(0, 50), label: `${label}: ${type.label}` });
      }
      await commitPanel("websites", pi);
      const kept = (await present()).some(([, ds]) => urlKey(shown(pick(ds, "websites", "url"))) === urlKey(url));
      if (done && kept) ok(label, `contact.${kind}_url`);
      else fail(label, `contact.${kind}_url`);
    }
  }

  // ============================================================ languages (each language its own entry)
  async function languages() {
    const langs = ctx.profile.languages;
    if (!(await scan(page)).some((f) => f.group === "languages") && !(await addButton(page, SECTION_RE.languages))) return;
    const assigned = new Map<number, number>();
    const used = new Set<number>();
    for (let k = 0; k < langs.length; k++) {
      for (const [pi, ds] of panelsOf(await scan(page), "languages")) {
        const v = shown(pick(ds, "languages", "language"));
        if (!used.has(pi) && v && matchLanguage(langs[k].language, [v]).pick) {
          assigned.set(k, pi);
          used.add(pi);
          break;
        }
      }
    }
    for (let k = 0; k < langs.length; k++) {
      await ctx.guard();
      const L = langs[k];
      let pi = assigned.get(k);
      if (pi === undefined) {
        pi = (await emptyPanel("languages", "language", assigned)) ?? (await addPanel("languages")) ?? undefined;
        if (pi === undefined) {
          fail(`Languages: ${L.language}`, "languages");
          break;
        }
        assigned.set(k, pi);
      }
      const ds = panelsOf(await scan(page), "languages").get(pi) ?? [];
      const langF = pick(ds, "languages", "language");
      if (langF) {
        const key = `languages:${k}:${langF.wdField || "language"}`;
        const given = answer(key);
        const decide = (labels: string[]) => (given ? labels.find((l) => norm(l) === norm(String(given))) ?? null : matchLanguage(L.language, labels).pick);
        let r = shown(langF) && decide([shown(langF)]) ? ({ ok: true, picked: [shown(langF)], seen: [] } as PickResult) : await choose(finder("languages", pi, "language"), langF, [L.language], decide);
        if (!r.ok && ctx.equivalent && r.seen.length && !given) {
          const alt = await ctx.equivalent("language", L.language, r.seen);
          if (alt) r = await choose(finder("languages", pi, "language"), langF, [alt], (labels) => labels.find((l) => norm(l) === norm(alt)) ?? null);
        }
        if (r.ok) ok(`Languages: ${L.language}`, "languages");
        else {
          fail(`Languages: ${L.language}`, "languages");
          if (langF.required) ask({ ...question(langF, key, "no_matching_option", false, L.language), options: r.seen.slice(0, 100), label: `Language: ${L.language}` });
          continue;
        }
      }
      // "I am fluent in this language": only for a saved fluent / native level.
      const fl = pick(panelsOf(await scan(page), "languages").get(pi) ?? [], "languages", "fluent");
      if (fl) await checkSet(page, () => locate(page, (x) => x.group === "languages" && x.groupIndex === pi && roleOf("languages", x) === "fluent"), L.level === "fluent" || L.level === "native");
      // Each proficiency control (overall, or reading / speaking / writing): the saved level, mapped exactly.
      const profs = (panelsOf(await scan(page), "languages").get(pi) ?? []).filter((x) => roleOf("languages", x) === "proficiency");
      for (const p of profs) {
        await ctx.guard();
        const key = `languages:${k}:${p.wdField || norm(p.label)}`.slice(0, 200);
        const given = answer(key);
        const label = `${L.language}: ${p.label.replace(/\*\s*$/, "")}`;
        const find: Finder = () => locate(page, (x) => x.group === "languages" && x.groupIndex === pi && x.label === p.label && roleOf("languages", x) === "proficiency");
        const decide = (labels: string[]) => (given ? labels.find((l) => norm(l) === norm(String(given))) ?? null : matchProficiency(L.level, labels).pick);
        const r = shown(p) && decide([shown(p)]) === shown(p) ? ({ ok: true, picked: [], seen: [] } as PickResult) : await choose(find, p, [L.level], decide);
        if (r.ok) ok(label, "languages.level");
        else if (p.required) ask({ ...question(p, key, "no_matching_option", false, L.level), options: r.seen.slice(0, 50), label });
        else skipped(label, "languages.level", `level “${L.level}” has no matching option`);
      }
      await commitPanel("languages", pi);
    }
  }

  // ============================================================ skills (one verified tag per skill)
  async function skills() {
    const list: string[] = [];
    for (const s of ctx.profile.skills) if (s.trim() && !list.some((x) => mnorm(x) === mnorm(s))) list.push(s.trim());
    if (!list.length) return;
    const box = (await scan(page)).find((f) => f.visible && f.group === "skills" && f.control === "combobox");
    if (!box) return;
    const find: Finder = () => locate(page, (f) => f.group === "skills" && f.control === "combobox" && (f.wdField === box.wdField || norm(f.label) === norm(box.label)));
    out.handled.add(fieldKey(box));
    let added = 0;
    for (const skill of list) {
      await ctx.guard();
      const chips = valuesOf((await find())?.f);
      if (matchSkill(skill, chips).pick) {
        ok(`Skills: ${skill}`, "skills", "kept");
        continue;
      }
      const committed = (f: FieldDescriptor, p: string) => valuesOf(f).some((v) => norm(v) === norm(p));
      let r = await searchSelect(page, find, { queries: [skill], choose: (labels) => matchSkill(skill, labels).pick, committed, guard: ctx.guard });
      if (!r.ok && r.reason === "no_match" && ctx.equivalent && r.seen.length) {
        const alt = await ctx.equivalent("skill", skill, r.seen);
        if (alt) r = await searchSelect(page, find, { queries: [skill], choose: (labels) => labels.find((l) => norm(l) === norm(alt)) ?? null, committed, guard: ctx.guard });
      }
      if (r.ok) {
        added++;
        ok(`Skills: ${skill}${norm(r.picked[0]) !== norm(skill) ? ` → ${r.picked[0]}` : ""}`, "skills");
      } else skipped(`Skills: ${skill}`, "skills", r.reason === "no_control" ? "the skills box disappeared" : "not offered by this employer's skills list");
    }
    await ctx.event("skills_added", { count: added, total: list.length });
  }

  // ============================================================ "How did you hear about us?"
  async function source() {
    const fields = await scan(page);
    const f = fields.find((x) => x.visible && !x.group && (x.wdField === "source" || questionMeaning(x.label, ctx.employer).meaning === "source") && ["combobox", "listbox", "select", "radio"].includes(x.control));
    if (!f) return;
    const key = fieldKey(f);
    if (answer(key) !== undefined) return; // the user's own answer: the generic planner fills it
    const src = ctx.jobSource;
    if (!src) return; // not known from the saved job: Application Defaults / the user decide
    const find: Finder = () => locate(page, (x) => fieldKey(x) === key);
    const committed = (x: FieldDescriptor, p: string) => valuesOf(x).some((v) => norm(v) === norm(p) || norm(v).endsWith(norm(p)));
    const leafOf = (labels: string[]) => matchSource(src, labels).leaf;
    const catsOf = (labels: string[]) => matchSource(src, labels).categories;
    const cur = valuesOf(f);
    if (cur.length && (leafOf(cur) || catsOf(cur).length)) {
      out.handled.add(key);
      ok(f.label, `job.source.${src}`, "kept");
      return;
    }
    let r: PickResult;
    if (f.control === "combobox") {
      r = await searchSelect(page, find, { queries: [SOURCE_QUERY[src]], choose: leafOf, committed, guard: ctx.guard });
      if (!r.ok) r = await browseSelect(page, find, { leaf: leafOf, categories: catsOf, committed });
      // No leaf anywhere: a truthful broader category that is itself selectable.
      if (!r.ok) r = await searchSelect(page, find, { queries: catsOf(r.seen).slice(0, 2), choose: (labels) => catsOf(labels)[0] ?? null, committed, guard: ctx.guard });
    } else r = await listSelect(page, find, (labels) => leafOf(labels) ?? catsOf(labels)[0] ?? null);
    if (r.ok) {
      out.handled.add(key);
      ok(f.label, `job.source.${src}`);
    } else await ctx.diag("source", [f], `no_option_for_${src}`);
  }

  // ============================================================ shared panel logic

  /** Matches panels already on the form to profile entries by their identifying values. */
  async function matchPanels(group: Group, entries: { first: string; second: string }[], ident: (ds: FieldDescriptor[]) => [string, string]) {
    const assigned = new Map<number, number>();
    const used = new Set<number>();
    for (const [pi, ds] of [...panelsOf(await scan(page), group).entries()].sort((a, b) => a[0] - b[0])) {
      const [first, second] = ident(ds).map(norm);
      if (!first) continue;
      const k = entries.findIndex((e, j) => !assigned.has(j) && norm(e.first) === first && (!second || !e.second || norm(e.second) === second));
      if (k >= 0 && !used.has(pi)) {
        assigned.set(k, pi);
        used.add(pi);
      }
    }
    return assigned;
  }

  async function emptyPanel(group: Group, anchor: Role, assigned: Map<number, number>): Promise<number | null> {
    const taken = new Set(assigned.values());
    for (const [pi, ds] of [...panelsOf(await scan(page), group).entries()].sort((a, b) => a[0] - b[0])) {
      if (!taken.has(pi) && !shown(pick(ds, group, anchor))) return pi;
    }
    return null;
  }

  /**
   * Entries on the form that are not in My Profile (e.g. from resume parsing) are kept and listed
   * for review; removed only when the user chose "Remove" for them.
   */
  async function extras(group: "work" | "education", assigned: Map<number, number>, ident: (ds: FieldDescriptor[]) => [string, string]) {
    const mine = new Set(assigned.values());
    const panels = [...panelsOf(await scan(page), group).entries()].sort((a, b) => b[0] - a[0]);
    for (const [pi, ds] of panels) {
      if (mine.has(pi)) continue;
      const desc = ident(ds).filter(Boolean).join(" — ");
      if (!desc) continue;
      const key = `${group}_extra:${norm(desc)}`.slice(0, 200);
      if (answer(key) === "Remove" && (await deletePanel(page, group, pi))) {
        ctx.record({ label: `${group === "work" ? "Work experience" : "Education"} removed (your choice): ${desc}`.slice(0, 300), source: "answer", verified: true });
        continue;
      }
      ctx.record({ label: `${group === "work" ? "Work experience" : "Education"} on the form, not in My Profile`, source: "site", verified: false, status: "parsed", value: desc.slice(0, 300) });
    }
  }
}
