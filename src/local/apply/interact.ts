// Low-level form interactions (Playwright), shared by the generic form flow and the Workday
// section handlers. Every helper re-reads the page instead of trusting earlier element handles:
// React re-renders replace nodes, so a control is found again (by its field identity) before
// each action, and every action is checked against what the page shows afterwards.
import { phoneAccepted } from "@shared/phone";
import type { Locator, Page } from "playwright-core";
import { SCAN_FIELDS } from "./dom";
import { fieldKey, norm, type FieldDescriptor, type PlannedAction } from "./plan";
import { WD_OPTION_SEL } from "./workday";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scan(page: Page): Promise<FieldDescriptor[]> {
  return (await page.evaluate(SCAN_FIELDS)) as FieldDescriptor[];
}

export const OPTION_SEL = `.select__option, [role="option"], [id*="-option-"], .ant-select-item-option, .MuiAutocomplete-option, ${WD_OPTION_SEL}`;

/**
 * The clickable option among duplicates: component libraries often render each option twice (a
 * visible item plus a hidden accessibility copy). Same text = same option; the visible item with the
 * library's option class wins.
 */
async function bestOption(cands: Locator[]): Promise<Locator | null> {
  if (!cands.length) return null;
  for (const o of cands) {
    const cls = String((await o.getAttribute("class", { timeout: 500 }).catch(() => "")) ?? "");
    if (/ant-select-item-option|select__option|MuiAutocomplete-option|promptOption/.test(cls)) return o;
  }
  for (const o of cands) {
    const box = await o.boundingBox().catch(() => null);
    if (box && box.width > 4 && box.height > 4) return o;
  }
  return cands[0];
}

/** Visible options of an open menu (never the Workday "selectedItemList" chips). */
/**
 * The options currently shown, read in ONE page call (long lists — 250 countries — used to cost
 * hundreds of round trips per read). Each option is tagged data-ca-opt="<n>" for clicking; chips of
 * already-selected values are excluded. Options of closed (display:none) menus have no size and are
 * skipped; options scrolled out of view inside an open list are kept.
 */
const READ_OPTIONS = (sel: string) => String.raw`(() => {
  document.querySelectorAll('[data-ca-opt]').forEach((x) => x.removeAttribute('data-ca-opt'));
  const out = [];
  let i = 0;
  for (const o of document.querySelectorAll(${JSON.stringify(sel)})) {
    const r = o.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const st = getComputedStyle(o);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    if (o.closest('[data-automation-id="selectedItemList"]')) continue;
    const t = (o.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    o.setAttribute('data-ca-opt', String(i));
    out.push({ i, t, cls: String(o.className || '') });
    i++;
    if (i >= 600) break;
  }
  return out;
})()`;

export interface ShownOption {
  i: number;
  t: string;
  cls: string;
}

export async function readOptions(page: Page): Promise<ShownOption[]> {
  return ((await page.evaluate(READ_OPTIONS(OPTION_SEL)).catch(() => [])) as ShownOption[]) ?? [];
}

export async function visibleOptions(page: Page): Promise<Locator[]> {
  return (await readOptions(page)).map((o) => page.locator(`[data-ca-opt="${o.i}"]`));
}

/** Marks the options already showing before a control is opened: they belong to another control (a list still closing). */
async function markStaleOptions(page: Page) {
  await page
    .evaluate(`(() => { document.querySelectorAll('[data-ca-stale]').forEach((e) => e.removeAttribute('data-ca-stale')); document.querySelectorAll(${JSON.stringify(OPTION_SEL)}).forEach((e) => { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) e.setAttribute('data-ca-stale', '1'); }); })()`)
    .catch(() => {});
}

/** The options that belong to THIS control: inside the list it points to (aria-controls / aria-owns), and not showing before it was opened (one page call). */
async function ownOptions(page: Page, loc: Locator): Promise<Locator[]> {
  const shown = await readOptions(page);
  if (!shown.length) return [];
  const mine = (await loc
    .evaluate((el) => {
      const listId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      const host = listId ? el.ownerDocument.getElementById(listId) : null;
      return [...el.ownerDocument.querySelectorAll("[data-ca-opt]")].filter((e) => !e.hasAttribute("data-ca-stale") && (!host || host.contains(e))).map((e) => e.getAttribute("data-ca-opt"));
    })
    .catch(() => null)) as (string | null)[] | null;
  const keep = mine ? new Set(mine) : null;
  return shown.filter((o) => !keep || keep.has(String(o.i))).map((o) => page.locator(`[data-ca-opt="${o.i}"]`));
}

/** Reads the options of comboboxes / listboxes (they exist only while the menu is open). */
export async function enrichOptions(page: Page, fields: FieldDescriptor[], guard?: () => Promise<void>): Promise<FieldDescriptor[]> {
  for (const f of fields) {
    if ((f.control !== "combobox" && f.control !== "listbox") || !f.visible || f.options.length || (f.control === "combobox" && f.asyncOptions)) continue;
    // An answered typeahead (its own text is the committed choice): opening it again only to read options
    // would put it back in "searching" state. Button-style lists (which show placeholders) are still read.
    if (f.control === "combobox" && valuesOf(f).length) continue;
    await guard?.();
    const loc = page.locator(`[data-ca-ref="${f.ref}"]`);
    try {
      await markStaleOptions(page);
      await loc.click({ timeout: 3000 });
      // Options may load after the menu opens: wait for them (up to 3 s) before reading — this control's own only.
      let found = await ownOptions(page, loc);
      for (let w = 0; w < 12 && !found.length; w++) {
        await sleep(250);
        found = await ownOptions(page, loc);
      }
      const texts: string[] = [];
      for (const o of found) {
        const tx = ((await o.textContent({ timeout: 1000 })) ?? "").replace(/\s+/g, " ").trim();
        if (tx) texts.push(tx);
      }
      f.options = texts.slice(0, 300).map((l) => ({ value: l, label: l }));
      if (f.control === "combobox") f.asyncOptions = !texts.length;
      await page.keyboard.press("Escape");
      await sleep(100);
    } catch {
      if (f.control === "combobox") f.asyncOptions = true;
    }
  }
  return fields;
}

export async function perform(page: Page, a: PlannedAction) {
  const loc = page.locator(`[data-ca-ref="${a.ref}"]`);
  // The page re-rendered since the scan: fail fast (the step is verified and asked again) instead of waiting.
  if (!(await loc.count())) throw new Error("stale_field");
  switch (a.kind) {
    case "fill":
      // Set the value through the DOM property React listens to. A date input and an open menu
      // both reject Playwright's fill().
      await loc.evaluate((el, value) => {
        const node = el as { value?: string; _valueTracker?: { setValue: (v: string) => void } };
        const previous = node.value ?? "";
        const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
        if (proto?.set) proto.set.call(el, value);
        // The prototype setter updates React's tracker to the new value, which makes the
        // following input event look like a no-op. Put the previous value back first.
        if (node._valueTracker) node._valueTracker.setValue(previous);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, a.value).catch(() => loc.fill(a.value));
      await loc.blur().catch(() => {});
      return;
    case "check":
      // A click (not setChecked): some forms re-render on change, which would make setChecked retry.
      if ((await loc.isChecked()) !== a.value) await loc.click({ force: true });
      return;
    case "date":
      // Workday date sections only commit real keystrokes.
      for (const part of ["month", "day", "year"] as const) {
        const v = a.value[part];
        const ref = a.parts[part];
        if (!v) continue;
        const target = ref ? page.locator(`[data-ca-ref="${ref}"]`) : null;
        if (!target) continue;
        await target.click();
        await target.press("ControlOrMeta+A");
        await target.pressSequentially(v);
      }
      await page.keyboard.press("Tab").catch(() => {});
      return;
    case "choose":
      if (a.control === "select") {
        await loc.selectOption({ label: a.values[0] });
        return;
      }
      if (a.control === "radio" || a.control === "checkboxes") {
        for (const r of a.optionRefs ?? []) await page.locator(`[data-ca-ref="${r}"]`).check({ force: true });
        return;
      }
      if (a.control === "listbox") return chooseListbox(page, loc, a.values[0]);
      if (a.control === "combobox") return comboPick(page, a, a.values[0], (labels) => labels.find((l) => norm(l) === norm(a.values[0])) ?? null);
      return;
    case "search": {
      // Only an unambiguous suggestion is taken (e.g. "Toronto, Ontario, Canada", not "Toronto, Ohio").
      const fits = (l: string) => a.match.every((m) => norm(l).includes(norm(m)));
      return comboPick(page, a, a.value, (labels) => {
        const hits = [...new Set(labels.filter(fits).map((l) => l.trim()))];
        const exact = hits.filter((l) => norm(l) === norm(a.value));
        return exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
      });
    }
  }
}

/** Option text actually chosen for an action (verified on the page), by field key (refs change on re-render). */
const picked = new Map<string, string>();

/**
 * A displayed value counts for the chosen option when it is that option, or the site's shortened
 * form of it (a dialing-code select shows "🇨🇦 +1" for "🇨🇦 +1 Canada").
 */
export const shownMatches = (shown: string[], choice: string) => shown.some((v) => norm(v) === norm(choice) || (v.trim().length >= 2 && choice.includes(v.trim())));

/**
 * Searchable or read-only dropdowns of any component library: search → pick → verify (searchSelect);
 * when typing is impossible or finds nothing, open the list and pick without typing (listSelect).
 * The control is found again by ref, then by field key, so a re-render doesn't lose it.
 */
async function comboPick(page: Page, a: PlannedAction, query: string, decide: (labels: string[]) => string | null) {
  const find: Finder = async () => {
    const all = await scan(page);
    const f = all.find((x) => x.ref === a.ref) ?? all.find((x) => x.visible && !x.group && fieldKey(x) === a.key);
    return f ? { f, loc: page.locator(`[data-ca-ref="${f.ref}"]`) } : null;
  };
  const committed = (x: FieldDescriptor, p: string) => shownMatches(valuesOf(x), p);
  let r = await searchSelect(page, find, { queries: [query], choose: decide, committed });
  if (process.env.CA_APPLY_DEBUG) process.stderr.write(`COMBO ${a.label.slice(0, 40)} search=${r.ok ? "ok" : r.reason} seen=${r.seen.length}\n`);
  if (!r.ok) r = await listSelect(page, find, decide, committed);
  if (r.ok) picked.set(a.key, r.picked[r.picked.length - 1]);
}

/**
 * Workday button dropdown: open, wait for the options, click the one with exactly this text, then
 * re-read the button until the choice has persisted (React may re-render); one retry.
 */
export async function chooseListbox(page: Page, loc: Locator, label: string) {
  // A React re-render after the choice replaces the button: then the caller's fresh scan verifies.
  const gone = async () => (await loc.count().catch(() => 0)) === 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await gone()) return;
    await loc.click({ timeout: 5000 });
    let opts = await visibleOptions(page);
    for (let w = 0; w < 12 && !opts.length; w++) {
      await sleep(250);
      opts = await visibleOptions(page);
    }
    let clicked = false;
    for (const o of opts) {
      if (norm(await o.textContent({ timeout: 1000 }).catch(() => "")) === norm(label)) {
        await o.click({ timeout: 4000 }).catch(() => o.click({ force: true, timeout: 4000 }));
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await page.keyboard.press("Escape");
      return;
    }
    for (let w = 0; w < 8; w++) {
      await sleep(250);
      if (await gone()) return;
      if (norm(await loc.textContent({ timeout: 500 }).catch(() => "")) === norm(label)) return;
    }
  }
}

/** Option labels of a closed menu. Reads them and leaves the menu; does not choose one. */
export async function readMenu(page: Page, ref: string): Promise<string[]> {
  const loc = page.locator(`[data-ca-ref="${ref}"]`);
  if (!(await loc.count().catch(() => 0))) return [];
  const ant = await loc.evaluate((el) => !!el.closest(".ant-select")).catch(() => false);
  await markStaleOptions(page);
  if (ant) await openAntSelect(loc);
  else await loc.click({ timeout: 3000 }).catch(() => {});
  const texts: string[] = [];
  for (let w = 0; w < 8 && !texts.length; w++) {
    await sleep(200);
    for (const o of await ownOptions(page, loc)) {
      const tx = ((await o.textContent({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      if (tx && !texts.includes(tx)) texts.push(tx);
    }
  }
  await loc.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  // Escape often leaves an Ant Design menu open. A second mousedown closes it.
  await loc.evaluate((el) => {
    if (el.getAttribute("aria-expanded") !== "true") return;
    const box = el.closest(".ant-select");
    const sel = (box?.querySelector(".ant-select-selector") ?? box) as { dispatchEvent?: (e: Event) => void } | null;
    const Mouse = (globalThis as { MouseEvent?: new (type: string, init: { bubbles: boolean; cancelable: boolean }) => Event }).MouseEvent;
    if (sel?.dispatchEvent && Mouse) sel.dispatchEvent(new Mouse("mousedown", { bubbles: true, cancelable: true }));
  }).catch(() => {});
  return texts.slice(0, 30);
}

/** Ant Design opens a select on mousedown of its selector, not on a click of the wrapper. */
async function openAntSelect(loc: Locator) {
  await loc.evaluate((el) => {
    const box = el.closest(".ant-select");
    const sel = (box?.querySelector(".ant-select-selector") ?? box) as { dispatchEvent?: (e: Event) => void } | null;
    const Mouse = (globalThis as { MouseEvent?: new (type: string, init: { bubbles: boolean; cancelable: boolean }) => Event }).MouseEvent;
    if (sel?.dispatchEvent && Mouse) sel.dispatchEvent(new Mouse("mousedown", { bubbles: true, cancelable: true }));
  });
}

export async function pickOption(page: Page, loc: Locator, text: string, fits: (normalizedLabel: string) => boolean, wait: number) {
  const ant = await loc.evaluate((el) => !!el.closest(".ant-select")).catch(() => false);
  if (ant) await openAntSelect(loc);
  else await loc.click();
  const readOnly = await loc.evaluate((el) => "readOnly" in el && !!(el as { readOnly?: boolean }).readOnly).catch(() => false);
  if (!readOnly) {
    // A searchable select filters on keystrokes. Setting the value in one go often does not.
    if (ant) await loc.pressSequentially(text, { delay: 15 }).catch(() => loc.fill(text).catch(() => {}));
    else await loc.fill(text).catch(() => {});
  }
  await sleep(wait);
  let opts = await visibleOptions(page);
  if (!opts.length) {
    // Workday prompts search on Enter.
    await loc.press("Enter").catch(() => {});
    await sleep(1200);
    opts = await visibleOptions(page);
  }
  // Group by text: duplicates of one option (accessibility copies) are one choice, not ambiguity.
  const byText = new Map<string, Locator[]>();
  for (const o of opts) {
    const t = norm(await o.textContent({ timeout: 1000 }).catch(() => ""));
    if (t && fits(t)) byText.set(t, [...(byText.get(t) ?? []), o]);
  }
  const exactText = [...byText.keys()].filter((t) => t === norm(text));
  const pickText = exactText.length === 1 ? exactText[0] : byText.size === 1 ? [...byText.keys()][0] : null;
  const chosen = pickText ? await bestOption(byText.get(pickText)!) : null;
  if (chosen) {
    await chosen.scrollIntoViewIfNeeded().catch(() => {});
    await chosen.click({ timeout: 4000 }).catch(() => chosen.click({ force: true, timeout: 4000 }));
  }
  await sleep(150);
  // Ant Design keeps the menu open after Escape on the page. Focus the control, then Escape.
  await loc.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
}

export function verify(actions: PlannedAction[], after: FieldDescriptor[], resume: { name: string }): Set<string> {
  const ok = new Set<string>();
  const byKey = new Map(after.map((f) => [fieldKey(f), f]));
  const byRef = new Map(after.map((f) => [f.ref, f]));
  const digits = (s: string) => s.replace(/\D+/g, "");
  for (const a of actions) {
    const f = byRef.get(a.ref) ?? byKey.get(a.key);
    if (!f) continue;
    const v = f.value;
    const list = (Array.isArray(v) ? v : [String(v ?? "")]).map(norm);
    let good = false;
    switch (a.kind) {
      case "upload":
        good = list.includes(norm(resume.name));
        break;
      case "fill":
        // Phones: the normalised number including its country (and the code shown beside it), never a suffix.
        good = a.phone ? phoneAccepted(String(v ?? ""), a.phone, f.phone?.dial) : /phone|tel/.test(`${f.name} ${f.id} ${f.inputType}`.toLowerCase()) ? digits(String(v)) === digits(a.value) && digits(a.value).length > 0 : norm(String(v)) === norm(a.value);
        break;
      case "check":
        good = v === a.value;
        break;
      case "date": {
        const want = [a.value.month, a.value.day, a.value.year].filter(Boolean).map((x) => String(Number(x))).join("/");
        good = String(v ?? "").split("/").map((x) => String(Number(x))).join("/") === want;
        break;
      }
      case "choose":
        good = a.values.every((x) => list.includes(norm(x))) || (picked.has(a.key) && shownMatches(valuesOf(f), picked.get(a.key)!));
        break;
      case "search":
        // A suggestion that was clicked must be what the control shows (typed query text is not a choice).
        good = picked.has(a.key) ? shownMatches(valuesOf(f), picked.get(a.key)!) : list.some((x) => a.match.every((m) => x.includes(norm(m))));
        break;
    }
    if (good) ok.add(a.ref);
  }
  return ok;
}


// ---------------------------------------------------------------- re-identification

export type Found = { f: FieldDescriptor; loc: Locator };
export type Finder = () => Promise<Found | null>;

/** Finds a control afresh (new scan, new handle) — never a reference from before a re-render. */
export async function locate(page: Page, pred: (f: FieldDescriptor) => boolean): Promise<Found | null> {
  const f = (await scan(page)).find((x) => x.visible && pred(x));
  return f ? { f, loc: page.locator(`[data-ca-ref="${f.ref}"]`) } : null;
}

export const valuesOf = (f: FieldDescriptor | null | undefined): string[] => {
  const v = f?.value;
  return (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map(String).filter(Boolean);
};

/** Texts of the options currently shown (a menu, a prompt's suggestions). */
export async function optionTexts(page: Page): Promise<string[]> {
  return [...new Set((await readOptions(page)).map((o) => o.t))];
}

async function waitOptions(page: Page, ms: number): Promise<string[]> {
  const until = Date.now() + ms;
  let last: string[] = [];
  while (Date.now() < until) {
    last = await optionTexts(page);
    if (last.length) {
      // Let a list that is still loading finish (same contents twice).
      await sleep(250);
      const again = await optionTexts(page);
      if (again.length === last.length) return again;
      last = again;
    }
    await sleep(200);
  }
  return last;
}

async function clickOption(page: Page, label: string): Promise<boolean> {
  const same = (await readOptions(page)).filter((o) => norm(o.t) === norm(label));
  if (!same.length) return false;
  // Several copies of one option (a visible item and an accessibility copy): the library's item wins.
  const best = same.find((o) => /ant-select-item-option|select__option|MuiAutocomplete-option|promptOption/.test(o.cls)) ?? same[0];
  const o = page.locator(`[data-ca-opt="${best.i}"]`);
  await o.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await o.click({ timeout: 4000 }).catch(() => o.click({ force: true, timeout: 4000 }));
  return true;
}

async function closeMenu(page: Page, input?: Locator) {
  if (input && (await input.isEditable({ timeout: 500 }).catch(() => false)) && (await input.inputValue({ timeout: 1000 }).catch(() => ""))) await input.fill("", { timeout: 2000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(120);
}

async function until(ms: number, check: () => Promise<boolean>): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}

export interface PickResult {
  ok: boolean;
  picked: string[];
  /** Options the site offered (for diagnostics and questions). */
  seen: string[];
  reason?: "no_control" | "no_options" | "no_match" | "not_committed";
}

/**
 * Search → select → commit, for Workday prompts and tag boxes (skills, school, field of study, …):
 * observe the control, type one query, wait for suggestions (Enter triggers search on prompts that
 * need it), choose with `choose` (never a guess), click it, wait for the chip / value, and verify
 * on a fresh scan. Typed text alone is never counted as a value. Each query is tried in turn.
 */
export async function searchSelect(
  page: Page,
  find: Finder,
  o: { queries: string[]; choose: (labels: string[], query: string) => string | null; committed: (f: FieldDescriptor, picked: string) => boolean; guard?: () => Promise<void> },
): Promise<PickResult> {
  const seen: string[] = [];
  let reason: PickResult["reason"] = "no_options";
  for (const query of o.queries) {
    await o.guard?.();
    const t = await find();
    if (!t) return { ok: false, picked: [], seen, reason: "no_control" };
    // Disabled (e.g. State before Country): nothing to do yet. Read-only (a plain dropdown): open it
    // and choose from the list without typing.
    if (await t.loc.isDisabled({ timeout: 500 }).catch(() => false)) return { ok: false, picked: [], seen, reason: "no_control" };
    const typeable = await t.loc.isEditable({ timeout: 500 }).catch(() => false);
    await t.loc.click({ timeout: 5000 }).catch(() => t.loc.click({ force: true, timeout: 5000 }).catch(() => {}));
    if (typeable) {
      await t.loc.fill("", { timeout: 2000 }).catch(() => {});
      await t.loc.fill(query, { timeout: 2000 }).catch(async () => {
        await t.loc.pressSequentially(query, { delay: 20, timeout: 5000 }).catch(() => {});
      });
    }
    let labels = await waitOptions(page, 2500);
    if (!labels.length && typeable) {
      await t.loc.press("Enter", { timeout: 2000 }).catch(() => {}); // prompts that search on Enter
      labels = await waitOptions(page, 4000);
    }
    for (const l of labels) if (!seen.includes(l)) seen.push(l);
    if (!labels.length) {
      await closeMenu(page, t.loc);
      continue;
    }
    const pick = o.choose(labels, query);
    if (!pick) {
      reason = "no_match";
      await closeMenu(page, t.loc);
      continue;
    }
    // Act, then verify; one alternative strategy (keyboard) when the click didn't commit.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 0) await clickOption(page, pick);
      else {
        const again = await find();
        if (!again) break;
        await again.loc.click({ timeout: 4000 }).catch(() => {});
        if (typeable) await again.loc.fill(pick, { timeout: 2000 }).catch(() => {});
        await waitOptions(page, 2500);
        if (!(await clickOption(page, pick)) && typeable) await again.loc.press("Enter", { timeout: 2000 }).catch(() => {});
      }
      const ok = await until(3000, async () => {
        const now = await find();
        return !!now && o.committed(now.f, pick);
      });
      if (ok) {
        // Close the list only: in a plain combobox the box itself holds the committed choice.
        await closeMenu(page);
        return { ok: true, picked: [pick], seen };
      }
    }
    reason = "not_committed";
    const now = await find();
    await closeMenu(page, now?.loc);
  }
  return { ok: false, picked: [], seen, reason };
}

/**
 * Hierarchical prompt (e.g. "How did you hear about us?" → Job Board → Indeed): opens the list,
 * takes the leaf when it is shown, otherwise opens each allowed category in turn and looks for the
 * leaf inside; goes back between categories. Verified on a fresh scan.
 */
export async function browseSelect(
  page: Page,
  find: Finder,
  o: { leaf: (labels: string[]) => string | null; categories: (labels: string[]) => string[]; committed: (f: FieldDescriptor, picked: string) => boolean },
): Promise<PickResult> {
  const seen: string[] = [];
  const open = async () => {
    const t = await find();
    if (!t) return null;
    await t.loc.fill("").catch(() => {});
    await t.loc.click({ timeout: 5000 }).catch(() => {});
    let labels = await waitOptions(page, 2500);
    if (!labels.length) {
      await t.loc.press("ArrowDown").catch(() => {});
      labels = await waitOptions(page, 2000);
    }
    for (const l of labels) if (!seen.includes(l)) seen.push(l);
    return labels;
  };
  const commit = async (pick: string) => {
    await clickOption(page, pick);
    return until(3000, async () => {
      const now = await find();
      return !!now && o.committed(now.f, pick);
    });
  };
  const top = await open();
  if (!top) return { ok: false, picked: [], seen, reason: "no_control" };
  if (!top.length) return { ok: false, picked: [], seen, reason: "no_options" };
  const direct = o.leaf(top);
  if (direct && (await commit(direct))) {
    await closeMenu(page);
    return { ok: true, picked: [direct], seen };
  }
  for (const cat of o.categories(top)) {
    const labels = (await optionTexts(page)).length ? await optionTexts(page) : await open();
    if (!labels?.includes(cat)) await open();
    await clickOption(page, cat);
    // A category opens its own list; a selectable category commits (then it is the answer).
    const sub = await waitOptions(page, 2500);
    const now = await find();
    if (now && o.committed(now.f, cat)) {
      await closeMenu(page);
      return { ok: true, picked: [cat], seen };
    }
    for (const l of sub) if (!seen.includes(l)) seen.push(l);
    const leaf = o.leaf(sub);
    if (leaf && (await commit(leaf))) {
      await closeMenu(page);
      return { ok: true, picked: [cat, leaf], seen };
    }
    const back = page.locator('[data-automation-id="promptBackButton"], [data-automation-id="backButton"], button[aria-label^="Back" i]').filter({ visible: true }).first();
    if (await back.count()) await back.click().catch(() => {});
    else await closeMenu(page);
  }
  await closeMenu(page);
  return { ok: false, picked: [], seen, reason: "no_match" };
}

/** Workday button listbox / select: open, read the options (they may load late), choose, verify. */
export async function listSelect(page: Page, find: Finder, choose: (labels: string[]) => string | null, committed?: (f: FieldDescriptor, picked: string) => boolean): Promise<PickResult> {
  const t = await find();
  if (!t) return { ok: false, picked: [], seen: [], reason: "no_control" };
  if (await t.loc.isDisabled({ timeout: 500 }).catch(() => false)) return { ok: false, picked: [], seen: [], reason: "no_control" };
  let labels: string[];
  if (t.f.control === "select" || t.f.control === "radio") labels = t.f.options.map((x) => x.label).filter((l) => !/^(select|choose|--)/i.test(l));
  else {
    await t.loc.click({ timeout: 5000 }).catch(() => {});
    labels = await waitOptions(page, 3000);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(100);
  }
  const pick = choose(labels);
  if (!pick) return { ok: false, picked: [], seen: labels, reason: labels.length ? "no_match" : "no_options" };
  const isOk = committed ?? ((f: FieldDescriptor, p: string) => valuesOf(f).some((v) => norm(v) === norm(p)));
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = await find();
    if (!now) break;
    if (isOk(now.f, pick)) return { ok: true, picked: [pick], seen: labels };
    if (now.f.control === "select") await now.loc.selectOption({ label: pick }).catch(() => {});
    else if (now.f.control === "radio") {
      const ref = now.f.options.find((x) => norm(x.label) === norm(pick))?.ref;
      if (ref) await page.locator(`[data-ca-ref="${ref}"]`).check({ force: true }).catch(() => {});
    } else if (now.f.control === "listbox") await chooseListbox(page, now.loc, pick).catch(() => {});
    else {
      await now.loc.click({ timeout: 4000 }).catch(() => {});
      await waitOptions(page, 2500);
      await clickOption(page, pick);
    }
    if (await until(2500, async () => {
      const x = await find();
      return !!x && isOk(x.f, pick);
    }))
      return { ok: true, picked: [pick], seen: labels };
  }
  return { ok: false, picked: [], seen: labels, reason: "not_committed" };
}

/** Types into a text control and verifies the page kept it (re-found after any re-render). */
export async function textSet(page: Page, find: Finder, value: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await find();
    if (!t) return false;
    if (norm(String(t.f.value ?? "")) === norm(value)) return true;
    if (attempt === 0) {
      await t.loc.fill(value).catch(() => {});
      await t.loc.blur().catch(() => {});
    } else {
      await t.loc.click({ timeout: 4000 }).catch(() => {});
      await t.loc.press("ControlOrMeta+A").catch(() => {});
      await t.loc.pressSequentially(value, { delay: 10 }).catch(() => {});
      await page.keyboard.press("Tab").catch(() => {});
    }
    if (await until(1500, async () => norm(String((await find())?.f.value ?? "")) === norm(value))) return true;
  }
  return false;
}

/** A checkbox to the wanted state, verified. */
export async function checkSet(_page: Page, find: Finder, want: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await find();
    if (!t) return false;
    if (t.f.value === want) return true;
    await t.loc.click({ force: true, timeout: 4000 }).catch(() => {});
    if (await until(1500, async () => (await find())?.f.value === want)) return true;
  }
  return false;
}

/** Workday date (month / year boxes): typed keystroke by keystroke, verified. */
export async function dateSet(page: Page, find: Finder, value: { month?: string; year?: string; day?: string }): Promise<boolean> {
  const want = [value.month, value.day, value.year].filter(Boolean).map((x) => String(Number(x))).join("/");
  const holds = (f: FieldDescriptor) => String(f.value ?? "").split("/").filter(Boolean).map((x) => String(Number(x))).join("/") === want;
  const t = await find();
  if (!t) return false;
  if (holds(t.f)) return true;
  const parts = t.f.parts ?? {};
  for (const k of ["month", "day", "year"] as const) {
    const v = value[k];
    const ref = parts[k];
    if (!v || !ref) continue;
    const box = page.locator(`[data-ca-ref="${ref}"]`);
    await box.click({ timeout: 4000 }).catch(() => {});
    await box.press("ControlOrMeta+A").catch(() => {});
    await box.pressSequentially(v).catch(() => {});
  }
  await page.keyboard.press("Tab").catch(() => {});
  return until(1500, async () => {
    const x = await find();
    return !!x && holds(x.f);
  });
}

// ---------------------------------------------------------------- interruptions

export type NoticeOutcome = { kind: "none" } | { kind: "dismissed"; button: string; text: string } | { kind: "consent"; text: string; checkbox: boolean } | { kind: "form" };

/**
 * Open dialogs, read from the page (not from a site list):
 *  - a routine informational notice ("I understand", "Got it", "Close", resume-upload confirmations,
 *    "section saved") → acknowledged;
 *  - "leave this page / unsaved changes" → stay;
 *  - anything that asks for consent or a declaration (checkboxes, "I agree", certify, background
 *    check, terms, privacy notice consent) → reported, never clicked here;
 *  - a dialog that is itself a form → left to the form logic.
 */
export const OPEN_DIALOGS = String.raw`(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 20 && r.height > 20 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sel = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .ant-modal, .modal.show, .MuiDialog-paper, .ReactModal__Content';
  const out = [];
  document.querySelectorAll('[data-ca-dlg]').forEach((x) => x.removeAttribute('data-ca-dlg'));
  let n = 0;
  for (const d of document.querySelectorAll(sel)) {
    if (!vis(d) || d.closest('[data-ca-seen]') || out.some((o) => o.el.contains(d))) continue;
    const inputs = [...d.querySelectorAll('input:not([type=hidden]), select, textarea')].filter(vis);
    const checkbox = inputs.some((i) => i.type === 'checkbox');
    const buttons = [...d.querySelectorAll('button, [role="button"], a[role="button"]')].filter(vis).map((b) => { n++; b.setAttribute('data-ca-dlg', 'd' + n); return { ref: 'd' + n, text: clean(b.getAttribute('aria-label') || b.innerText) }; });
    out.push({ el: d, text: clean(d.innerText).slice(0, 1500), checkbox, fields: inputs.filter((i) => i.type !== 'checkbox' && i.type !== 'radio').length, buttons });
  }
  return out.map(({ el, ...rest }) => rest);
})()`;

const ACK_RE = /^(ok|okay|got it|i understand|understood|close|dismiss|continue|acknowledged?|i acknowledge|i have read( this| the)?( information| notice)?|yes,? continue|proceed|return to (the )?application|×|x)$/i;
const STAY_RE = /^(stay|stay on (this )?page|cancel|no|keep editing|go back)$/i;
const LEAVE_RE = /leave (this )?(page|site)|unsaved changes|changes (you made )?(may|will) not be saved|discard (your )?changes/i;
const BINDING_RE = /\b(i (hereby )?(agree|consent|certify|attest|declare|authori[sz]e)|terms (and|&) conditions|terms of (use|service)|consent|certif|attest|background (check|screening)|drug (test|screen)|signature|e-?sign|arbitration|non-?compete|true,? (accurate|correct) and complete|authori[sz]e .*(contact|verify|release))\b/i;

export async function handleNotices(page: Page): Promise<NoticeOutcome[]> {
  const out: NoticeOutcome[] = [];
  for (let round = 0; round < 3; round++) {
    const dialogs = (await page.evaluate(OPEN_DIALOGS).catch(() => [])) as { text: string; checkbox: boolean; fields: number; buttons: { ref: string; text: string }[] }[];
    if (!dialogs.length) break;
    let acted = false;
    for (const d of dialogs) {
      if (d.fields > 0) {
        out.push({ kind: "form" });
        continue;
      }
      if (LEAVE_RE.test(d.text)) {
        const stay = d.buttons.find((b) => STAY_RE.test(b.text));
        if (stay) {
          await page.locator(`[data-ca-dlg="${stay.ref}"]`).click({ timeout: 4000 }).catch(() => {});
          out.push({ kind: "dismissed", button: stay.text, text: d.text.slice(0, 200) });
          acted = true;
        }
        continue;
      }
      if (d.checkbox || BINDING_RE.test(d.text)) {
        out.push({ kind: "consent", text: d.text.slice(0, 600), checkbox: d.checkbox });
        continue;
      }
      const ack = d.buttons.find((b) => ACK_RE.test(b.text));
      if (ack) {
        await page.locator(`[data-ca-dlg="${ack.ref}"]`).click({ timeout: 4000 }).catch(() => {});
        await sleep(400);
        out.push({ kind: "dismissed", button: ack.text, text: d.text.slice(0, 200) });
        acted = true;
      }
    }
    if (!acted) break;
  }
  return out;
}

/**
 * Sections that keep edits only after their own Save / Update button (cards, inline editors): press
 * each visible one once — never a page-level Next / Submit / Save and Continue.
 */
export async function commitOpenSections(page: Page): Promise<number> {
  const marked = (await page
    .evaluate(String.raw`(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      document.querySelectorAll('[data-ca-commit]').forEach((x) => x.removeAttribute('data-ca-commit'));
      let n = 0;
      for (const b of document.querySelectorAll('button, [role="button"]')) {
        const t = (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!vis(b) || !/^(update|save)$/i.test(t) || b.disabled) continue;
        if (b.closest('footer, [class*="footer"], [data-automation-id="pageFooter"], [role="dialog"]')) continue;
        // Only a button that sits in a block of its own form fields (an inline section editor).
        let a = b.parentElement, ok = false;
        // Layout libraries nest a button deeply (Ant: 6+ wrappers); the nearest block with fields is its section.
        for (let d = 0; a && d < 14 && a !== document.body; d++, a = a.parentElement) { if ([...a.querySelectorAll('input:not([type=hidden]), textarea')].some(vis)) { ok = true; break; } }
        if (!ok) continue;
        n++; b.setAttribute('data-ca-commit', String(n));
      }
      return n;
    })()`)
    .catch(() => 0)) as number;
  for (let i = 1; i <= marked; i++) {
    await page.locator(`[data-ca-commit="${i}"]`).click({ timeout: 4000 }).catch(() => {});
    await sleep(500);
  }
  return marked;
}

// ---------------------------------------------------------------- navigation-safe page reads

const NAV_RACE = /Execution context was destroyed|Cannot find context with specified id|frame was detached|Frame was detached|Navigation interrupted|context or browser has been closed.*navigat/i;

/**
 * Makes every page.evaluate on this page survive the site navigating at that moment (a redirect
 * after Apply, a step change after Next): wait for the new document and read it again, a few times.
 * Applied once per page (tabs opened later included), so every reader benefits — not one site.
 */
export function navigationSafe(page: Page): Page {
  const p = page as Page & { __caSafe?: boolean };
  if (p.__caSafe) return page;
  p.__caSafe = true;
  const orig = page.evaluate.bind(page) as (...a: unknown[]) => Promise<unknown>;
  (page as unknown as { evaluate: (...a: unknown[]) => Promise<unknown> }).evaluate = async (...args: unknown[]) => {
    for (let i = 0; ; i++) {
      try {
        return await orig(...args);
      } catch (e) {
        if (i >= 6 || page.isClosed() || !NAV_RACE.test(String((e as Error)?.message ?? e))) throw e;
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        await sleep(300 + i * 200);
      }
    }
  };
  return page;
}

/**
 * Work inside an embedded frame (a form hosted in an iframe — iCIMS and many company sites) with the
 * same tools as a page: reads, locators and roles go to the frame; keyboard, mouse, screenshots,
 * events and the tab itself stay with the real page. Reads are navigation-safe like a page's.
 */
export function frameView(page: Page, frame: import("playwright-core").Frame): Page {
  const fromFrame = new Set(["evaluate", "locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "url", "waitForLoadState", "goto", "content", "title", "$", "$$", "waitForSelector", "waitForTimeout"]);
  const evalSafe = async (...args: unknown[]) => {
    for (let i = 0; ; i++) {
      try {
        return await (frame.evaluate as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (e) {
        if (i >= 6 || page.isClosed() || !NAV_RACE.test(String((e as Error)?.message ?? e))) throw e;
        await frame.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        await sleep(300 + i * 200);
      }
    }
  };
  return new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === "evaluate") return evalSafe;
      if (prop === "__caFrame") return frame;
      if (typeof prop === "string" && fromFrame.has(prop)) {
        const v = (frame as unknown as Record<string, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(frame) : v;
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Page;
}

// ---------------------------------------------------------------- unfamiliar controls (general tools)

/** Elements that can be a choice in a custom dropdown, autocomplete or button list. */
const PICKABLE = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="treeitem"], [role="radio"], li, button, a, [onclick], [data-value], [tabindex]';

/** Marks every choice-like element visible now, so the ones that appear after opening a control can be told apart. */
export async function markVisibleChoices(page: Page) {
  await page
    .evaluate(`(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      document.querySelectorAll('[data-ca-pre]').forEach((e) => e.removeAttribute('data-ca-pre'));
      document.querySelectorAll(${JSON.stringify(PICKABLE)}).forEach((e) => { if (vis(e)) e.setAttribute('data-ca-pre', '1'); });
    })()`)
    .catch(() => {});
}

/**
 * The choices a control showed when it was opened (visible now, not before; innermost element per text),
 * tagged data-ca-pick="<i>" for clicking. Texts only.
 */
export async function newChoices(page: Page): Promise<{ i: number; text: string }[]> {
  return ((await page
    .evaluate(`(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      document.querySelectorAll('[data-ca-pick]').forEach((e) => e.removeAttribute('data-ca-pick'));
      const all = [...document.querySelectorAll(${JSON.stringify(PICKABLE)})].filter((e) => vis(e) && !e.hasAttribute('data-ca-pre') && !e.closest('[data-ca-outside]'));
      const text = (e) => (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
      const out = [];
      for (const e of all) {
        const t = text(e);
        if (!t || t.length > 120) continue;
        if (all.some((c) => c !== e && e.contains(c) && text(c) === t)) continue; // innermost with the same text
        if (out.some((o) => o.text === t)) continue;
        e.setAttribute('data-ca-pick', String(out.length));
        out.push({ i: out.length, text: t });
        if (out.length >= 200) break;
      }
      return out;
    })()`)
    .catch(() => [])) as { i: number; text: string }[]);
}

/** Opens a control (a field or the button that opens it), optionally types a query, and reads the choices that appear. */
export async function openChoices(page: Page, opener: Locator, query?: string): Promise<{ i: number; text: string }[]> {
  await markVisibleChoices(page);
  await opener.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await opener.click({ timeout: 4000 }).catch(() => opener.click({ force: true, timeout: 3000 }).catch(() => {}));
  if (query && (await opener.isEditable({ timeout: 500 }).catch(() => false))) {
    await opener.fill("", { timeout: 2000 }).catch(() => {});
    await opener.pressSequentially(query, { delay: 30, timeout: 6000 }).catch(() => {});
  }
  let seen: { i: number; text: string }[] = [];
  for (let w = 0; w < 12; w++) {
    await sleep(250);
    const now = await newChoices(page);
    if (now.length && now.length === seen.length) return now;
    seen = now;
  }
  return seen;
}
