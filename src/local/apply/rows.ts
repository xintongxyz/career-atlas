// Repeated rows on non-Workday forms (employment history, education history), filled from My Profile.
//
// Many career sites (Dayforce, SmartRecruiters, iCIMS, custom React forms) show one editable row per
// entry with its own Save / Update button; after saving, the row becomes a read-only summary and an
// "Add …" button opens the next one. This handler works from what the page shows, not from a site:
//   observe the section → is this entry already saved (its summary shows)? → reuse an empty editable
//   row or press THIS section's Add → fill each control by its meaning (title, employer, dates, school,
//   degree, major, country, completion) → press the row's Save/Update → verify the entry shows.
// Every school / job keeps its own values. Missing facts are never invented: a required field the
// profile can't answer becomes a question; an optional one stays empty.
import type { FilledField, PendingQuestion } from "@shared/apply";
import { matchDegree, mnorm, sameSchool } from "@shared/apply-match";
import { domainForLabel, englishCountry, matchOptionSemantic } from "@shared/apply-semantic";
import type { Profile } from "@shared/profile";
import type { Page } from "playwright-core";
import { checkSet, listSelect, locate, scan, searchSelect, textSet, valuesOf, type Finder } from "./interact";
import { norm, question, type FieldDescriptor } from "./plan";
import { addButton, savePanel } from "./workday";

type Group = "work" | "education";
type Role = "title" | "company" | "current" | "start" | "end" | "description" | "country" | "region" | "city" | "school" | "degree" | "major" | "minor" | "notCompleted" | "completed" | "gpa" | "other";

export interface RowsCtx {
  page: Page;
  profile: Profile;
  answers: Record<string, unknown>;
  guard: () => Promise<void>;
  record: (f: FilledField) => void;
  event: (code: string, params?: Record<string, string | number>) => Promise<void>;
  /** Field label being worked on (never a value). */
  progress?: (label: string) => Promise<void>;
  /**
   * When no offered option matches by rules: which option is the SAME thing as the value (an AI judgement,
   * owner opt-in) — "same" (alias / spelling) or, for a field of study, "broader" (a field that contains it).
   */
  judge?: (value: string, options: string[], kind: "school" | "major" | "degree" | "other") => Promise<{ pick: string; relation: "same" | "broader" } | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECTION: Record<Group, RegExp> = { work: /employment|work|experience|job history|position/, education: /education|school|academic/ };

export function rowRole(group: Group, f: FieldDescriptor): Role {
  const l = norm(`${f.label} ${f.wdField ?? ""}`);
  if (/country/.test(l)) return "country";
  if (/state|province|region/.test(l)) return "region";
  if (/\bcity\b|town/.test(l)) return "city";
  if (group === "work") {
    if (f.control === "checkbox" && /current|present|still|currently/.test(l)) return "current";
    if (/title|position|role\b|job name/.test(l)) return "title";
    if (/employer|company|organi[sz]ation|business name/.test(l)) return "company";
    if (/start|from|begin/.test(l)) return "start";
    if (/\bend\b|\bto\b|until|finish/.test(l)) return "end";
    if (/dut|description|responsib|summary|achiev/.test(l)) return "description";
    return "other";
  }
  if (f.control === "checkbox" && /not completed|in progress|currently (attending|enrolled)|still (studying|attending)|ongoing/.test(l)) return "notCompleted";
  if (f.control === "checkbox" && /\b(completed|graduated)\b/.test(l)) return "completed";
  if (/school|institution|university|college/.test(l)) return "school";
  if (/minor/.test(l)) return "minor";
  if (/major|field of study|discipline|program|area of study|concentration/.test(l)) return "major";
  if (/degree|qualification|credential|level of education/.test(l)) return "degree";
  if (/gpa|grade/.test(l)) return "gpa";
  if (/start|from|begin/.test(l)) return "start";
  if (/\bend\b|\bto\b|graduat|completion|expected/.test(l)) return "end";
  return "other";
}

const DEGREE_NAME: Record<string, string> = { high_school: "High School Diploma", diploma: "Diploma", bachelor: "Bachelor's Degree", master: "Master's Degree", doctorate: "Doctorate" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2024-06" → a date input's "2024-06-01" (day not recorded: the 1st, noted at Review); "2024" → null. */
function dateValue(f: FieldDescriptor, ym: string | null | undefined): { value: string; dayAssumed: boolean } | null {
  if (!ym) return null;
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(ym);
  if (!m) return null;
  // Split date controls ("Start date month" / "Start date year"): each gets its own part.
  if (/\bmonth\b/i.test(f.label)) return m[2] ? { value: f.control === "text" && f.inputType !== "text" ? m[2] : f.control === "text" ? m[2] : MONTHS[Number(m[2]) - 1], dayAssumed: false } : null;
  if (/\byear\b/i.test(f.label)) return { value: m[1], dayAssumed: false };
  if (f.inputType === "date") return m[2] ? { value: `${m[1]}-${m[2]}-01`, dayAssumed: true } : null;
  if (f.inputType === "month") return m[2] ? { value: `${m[1]}-${m[2]}`, dayAssumed: false } : null;
  return { value: m[2] ? `${m[2]}/${m[1]}` : m[1], dayAssumed: false };
}

const rowsOf = (fields: FieldDescriptor[], group: Group) => {
  const m = new Map<number, FieldDescriptor[]>();
  for (const f of fields) if (f.visible && f.group === group && f.groupIndex != null && f.groupIndex >= 0) m.set(f.groupIndex, [...(m.get(f.groupIndex) ?? []), f]);
  return m;
};

export async function fillRows(ctx: RowsCtx): Promise<{ questions: PendingQuestion[] }> {
  const questions: PendingQuestion[] = [];
  const { page } = ctx;
  for (const group of ["work", "education"] as const) {
    const entries = group === "work" ? ctx.profile.experience : ctx.profile.education;
    if (!entries.length) continue;
    const fields = await scan(page);
    if (!fields.some((f) => f.group === group) && !(await addButton(page, SECTION[group]))) continue;
    for (let k = 0; k < entries.length; k++) {
      await ctx.guard();
      const e = entries[k];
      const ident = group === "work" ? [(e as Profile["experience"][number]).title, (e as Profile["experience"][number]).organization ?? ""] : [(e as Profile["education"][number]).institution ?? "", ""];
      const tag = ident.filter(Boolean).join(" — ") || `${group} ${k + 1}`;
      // 1. Already saved on the page (a summary card shows it) or already in an open row: leave it.
      if (await savedOnPage(page, group, ident)) {
        ctx.record({ label: `${group === "work" ? "Employment" : "Education"}: ${tag}`.slice(0, 300), source: group === "work" ? "experience" : "education", verified: true, status: "kept" });
        continue;
      }
      // 2. An editable row whose identifying field is still empty, else this section's Add button.
      let idx = await emptyRow(page, group);
      if (idx === null) idx = await addRow(page, group);
      if (idx === null) {
        ctx.record({ label: `${group === "work" ? "Employment" : "Education"}: ${tag} (no Add button found)`.slice(0, 300), source: group, verified: false });
        break;
      }
      await fillRow(group, idx, k, tag);
      // 3. Save the row when it has its own Save / Update / Done button; then verify it shows.
      const ds = rowsOf(await scan(page), group).get(idx) ?? [];
      const saved = ds.length ? await savePanel(page, ds.map((d) => d.ref)) : false;
      if (saved) await sleep(600);
      const ok = await savedOnPage(page, group, ident);
      ctx.record({ label: `${group === "work" ? "Employment" : "Education"}: ${tag}`.slice(0, 300), source: group === "work" ? "experience" : "education", verified: ok });
      if (saved && !ok) {
        // The site refused the row (validation): its required fields become questions below.
        for (const f of rowsOf(await scan(page), group).get(idx) ?? []) {
          if (f.required && !valuesOf(f).length && f.value !== true) questions.push({ ...question(f, `${group}:${k}:${norm(f.label)}`.slice(0, 200), "missing", false), label: `${tag}: ${f.label}`.slice(0, 500) });
        }
        break; // don't open more rows on top of a rejected one
      }
    }
  }
  return { questions };

  async function fillRow(group: Group, idx: number, k: number, tag: string) {
    const find = (role: Role, label?: string): Finder => () => locate(page, (f) => f.group === group && f.groupIndex === idx && rowRole(group, f) === role && (!label || f.label === label));
    const ds = rowsOf(await scan(page), group).get(idx) ?? [];
    const e = group === "work" ? ctx.profile.experience[k] : null;
    const ed = group === "education" ? ctx.profile.education[k] : null;
    // The "current" / "not completed" boxes first: they show or hide the end date.
    for (const f of ds) {
      const role = rowRole(group, f);
      const want = role === "current" && e ? e.current : role === "notCompleted" && ed ? ed.completed === false : role === "completed" && ed ? ed.completed === true : null;
      if (want === null || ed?.completed === null && role !== "current") continue;
      const ok = await checkSet(page, find(role, f.label), want);
      ctx.record({ label: `${tag}: ${f.label}`.slice(0, 300), source: group === "work" ? "experience.current" : "education.completed", verified: ok });
    }
    for (const f0 of rowsOf(await scan(page), group).get(idx) ?? []) {
      await ctx.guard();
      const role = rowRole(group, f0);
      if (role === "current" || role === "notCompleted" || role === "completed" || role === "other") continue;
      const key = `${group}:${k}:${norm(f0.label)}`.slice(0, 200);
      await ctx.progress?.(`${group} ${k + 1}: ${f0.label}`);
      const given = ctx.answers[key];
      let value: string | null = given !== undefined && given !== null && given !== "" ? String(given) : null;
      let note = "";
      // An answer given as a month ("2025-09") goes into a calendar-date input as the 1st.
      if (value && (role === "start" || role === "end") && /^\d{4}(-\d{2})?$/.test(value)) {
        const d = dateValue(f0, value);
        if (d) {
          value = d.value;
          if (d.dayAssumed) note = " (day not recorded: 1st used)";
        }
      }
      if (value === null && e) {
        if (role === "title") value = e.title;
        else if (role === "company") value = e.organization ?? null;
        else if (role === "description") value = e.description ?? null;
        else if (role === "start" || (role === "end" && !e.current)) {
          const d = dateValue(f0, role === "start" ? e.start : e.end);
          if (d) {
            value = d.value;
            if (d.dayAssumed) note = " (day not recorded: 1st used)";
          }
        }
      }
      if (value === null && ed) {
        if (role === "school") value = ed.institution ?? null;
        else if (role === "major") value = ed.field ?? null;
        else if (role === "country") value = ed.country ? englishCountry(ed.country) : null;
        else if (role === "degree") value = f0.control === "text" ? DEGREE_NAME[ed.level] ?? null : ed.level;
        else if (role === "start" && ed.start) {
          const d = dateValue(f0, ed.start);
          if (d) {
            value = d.value;
            if (d.dayAssumed) note = " (day not recorded: 1st used)";
          }
        } else if (role === "end" && (ed.end || ed.year)) {
          const d = dateValue(f0, ed.end ?? String(ed.year));
          if (d) {
            value = d.value;
            if (d.dayAssumed) note = " (day not recorded: 1st used)";
          }
        }
      }
      if (value === null || value === "") {
        // A missing education start date belongs to THIS school: the answer is saved to that entry.
        if (f0.required && !valuesOf(f0).length) questions.push({ ...question(f0, key, "missing", false), label: `${tag}: ${f0.label}`.slice(0, 500), ...(group === "education" && role === "start" && ed?.institution ? { meaning: "education_start", entry: ed.institution, rememberable: false } : {}) });
        continue;
      }
      let ok = false;
      if (f0.control === "text" || f0.control === "textarea") ok = await textSet(page, find(role, f0.label), value);
      else if (["select", "listbox", "radio", "combobox"].includes(f0.control)) {
        const domain = role === "country" ? "country" : role === "degree" ? "degree" : domainForLabel(f0.label);
        const decide = (labels: string[]) => {
          if (role === "degree" && ed && !given) return matchDegree(ed.level, labels).pick;
          const mi = MONTHS.indexOf(value!);
          if (mi >= 0) {
            const forms = [MONTHS[mi], MONTHS[mi].slice(0, 3), String(mi + 1), String(mi + 1).padStart(2, "0")].map((x) => x.toLowerCase());
            const hit = labels.filter((l) => forms.includes(l.trim().toLowerCase().replace(/\.$/, "")));
            if (hit.length >= 1) return hit[0];
          }
          return (matchOptionSemantic(labels.map((l) => ({ value: l, label: l })), value!, domain)?.label as string | undefined) ?? null;
        };
        const committed = (x: FieldDescriptor, p: string) => valuesOf(x).some((v) => norm(v) === norm(p) || mnorm(v).endsWith(mnorm(p)));
        const r = f0.control === "combobox" ? await searchSelect(page, find(role, f0.label), { queries: [value], choose: decide, committed, guard: ctx.guard }) : await listSelect(page, find(role, f0.label), decide, committed);
        if (!r.ok && f0.control === "combobox") ok = (await listSelect(page, find(role, f0.label), decide, committed)).ok;
        else ok = r.ok;
        // Not offered under that exact name: look at what the site offers (shorter searches), let the judge
        // pick the SAME entry (or a broader field of study), else the site's "Other" — never a different one.
        if (!ok && (role === "school" || role === "major") && value) {
          const seen = new Set(r.seen);
          if (f0.control === "combobox") {
            const words = value.split(/\s+/).filter((w) => w.length > 3 && !/^(university|college|institute|school|of|the|and)$/i.test(w));
            // Shorter forms of the name show what the site offers; "Other" is looked for explicitly.
            for (const q of [...new Set([words.slice(0, 2).join(" "), words[0], "Other"].filter(Boolean))]) {
              const look = await searchSelect(page, find(role, f0.label), { queries: [q], choose: () => null, committed: () => false, guard: ctx.guard });
              look.seen.forEach((x) => seen.add(x));
            }
          }
          const options = [...seen].filter((x) => x && !/^(select|choose|--)/i.test(x));
          const verdict = options.length && ctx.judge ? await ctx.judge(value, options, role).catch(() => null) : null;
          const accept = verdict && options.includes(verdict.pick) && (verdict.relation === "same" || (role === "major" && verdict.relation === "broader")) ? verdict.pick : null;
          const other = options.find((x) => /^other\b/i.test(x.trim()));
          const pick = accept ?? other ?? null;
          if (pick) {
            const exact = (labels: string[]) => labels.find((l) => norm(l) === norm(pick)) ?? null;
            const again = f0.control === "combobox" ? await searchSelect(page, find(role, f0.label), { queries: [pick], choose: exact, committed, guard: ctx.guard }) : await listSelect(page, find(role, f0.label), exact, committed);
            ok = again.ok;
            if (ok) note = accept ? (verdict!.relation === "broader" ? ` (closest broader field offered: ${pick})` : ` (as listed: ${pick})`) : " (not listed: “Other” chosen)";
          }
        }
      }
      ctx.record({ label: `${tag}: ${f0.label.replace(/\*\s*$/, "")}${note}`.slice(0, 300), source: group === "work" ? "experience" : "education", verified: ok });
      if (!ok && f0.required) questions.push({ ...question(f0, key, "not_accepted", false, value), label: `${tag}: ${f0.label}`.slice(0, 500) });
    }
  }
}

/** Is this entry already on the page — as a saved summary, or in a filled row? */
async function savedOnPage(page: Page, group: Group, ident: string[]): Promise<boolean> {
  const [first, second] = ident.map((x) => mnorm(x));
  if (!first) return false;
  // A filled editable row with the same identity.
  for (const [, ds] of rowsOf(await scan(page), group)) {
    const v = ds.map((d) => valuesOf(d).join(" ")).map(mnorm);
    if (v.some((x) => x === first || (group === "education" && sameSchool(x, ident[0])))) return true;
  }
  // A read-only summary (outside form controls) naming it.
  const text = mnorm(
    String(
      await page
        .evaluate(`(() => { const c = document.body.cloneNode(true); c.querySelectorAll('input,textarea,select,script,style,[role="listbox"]').forEach((x) => x.remove()); return c.innerText || c.textContent || ''; })()`)
        .catch(() => ""),
    ),
  );
  return text.includes(first) && (!second || text.includes(second));
}

async function emptyRow(page: Page, group: Group): Promise<number | null> {
  for (const [i, ds] of [...rowsOf(await scan(page), group).entries()].sort((a, b) => a[0] - b[0])) {
    const anchor = ds.find((d) => rowRole(group, d) === (group === "work" ? "title" : "school"));
    if (anchor && !valuesOf(anchor).length) return i;
  }
  return null;
}

async function addRow(page: Page, group: Group): Promise<number | null> {
  const before = new Set(rowsOf(await scan(page), group).keys());
  const btn = await addButton(page, SECTION[group]);
  if (!btn) return null;
  await btn.click({ timeout: 5000 }).catch(() => btn.click({ force: true, timeout: 5000 }).catch(() => {}));
  for (let w = 0; w < 25; w++) {
    await sleep(200);
    const now = rowsOf(await scan(page), group);
    const fresh = [...now.keys()].filter((i) => !before.has(i));
    if (fresh.length) return Math.max(...fresh);
    // Some sites reuse index 0 for the newly opened row after the previous one was saved.
    const empty = await emptyRow(page, group);
    if (empty !== null && now.size >= before.size) return empty;
  }
  return null;
}
