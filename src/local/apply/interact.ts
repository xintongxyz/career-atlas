// Low-level form interactions (Playwright), shared by the generic form flow and the Workday
// section handlers. Every helper re-reads the page instead of trusting earlier element handles:
// React re-renders replace nodes, so a control is found again (by its field identity) before
// each action, and every action is checked against what the page shows afterwards.
import type { Locator, Page } from "playwright-core";
import { SCAN_FIELDS } from "./dom";
import { fieldKey, norm, type FieldDescriptor, type PlannedAction } from "./plan";
import { WD_OPTION_SEL } from "./workday";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scan(page: Page): Promise<FieldDescriptor[]> {
  return (await page.evaluate(SCAN_FIELDS)) as FieldDescriptor[];
}

export const OPTION_SEL = `.select__option, [role="option"], [id*="-option-"], ${WD_OPTION_SEL}`;

/** Visible options of an open menu (never the Workday "selectedItemList" chips). */
export async function visibleOptions(page: Page): Promise<Locator[]> {
  const loc = page.locator(OPTION_SEL).filter({ visible: true });
  const out: Locator[] = [];
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const o = loc.nth(i);
    if (await o.evaluate((e) => !e.closest('[data-automation-id="selectedItemList"]'), undefined, { timeout: 1000 }).catch(() => false)) out.push(o);
  }
  return out;
}

/** Reads the options of comboboxes / listboxes (they exist only while the menu is open). */
export async function enrichOptions(page: Page, fields: FieldDescriptor[], guard?: () => Promise<void>): Promise<FieldDescriptor[]> {
  for (const f of fields) {
    if ((f.control !== "combobox" && f.control !== "listbox") || !f.visible || f.options.length || (f.control === "combobox" && f.asyncOptions)) continue;
    await guard?.();
    const loc = page.locator(`[data-ca-ref="${f.ref}"]`);
    try {
      await loc.click({ timeout: 3000 });
      // Options may load after the menu opens: wait for them (up to 3 s) before reading.
      let found = await visibleOptions(page);
      for (let w = 0; w < 12 && !found.length; w++) {
        await sleep(250);
        found = await visibleOptions(page);
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
      if (a.control === "combobox") return pickOption(page, loc, a.values[0], (l) => l === norm(a.values[0]), 250);
      return;
    case "search":
      // Only an unambiguous suggestion is taken (e.g. "Toronto, Ontario, Canada", not "Toronto, Ohio").
      return pickOption(page, loc, a.value, (l) => a.match.every((m) => l.includes(norm(m))), 1500);
  }
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
  if (ant) await openAntSelect(loc);
  else await loc.click({ timeout: 3000 }).catch(() => {});
  const texts: string[] = [];
  for (let w = 0; w < 8 && !texts.length; w++) {
    await sleep(200);
    for (const o of await visibleOptions(page)) {
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
  const hits: Locator[] = [];
  for (const o of opts) if (fits(norm(await o.textContent({ timeout: 1000 })))) hits.push(o);
  const exact: Locator[] = [];
  for (const o of hits) if (norm(await o.textContent({ timeout: 1000 })) === norm(text)) exact.push(o);
  const chosen = exact.length === 1 ? exact : hits.length === 1 ? hits : [];
  if (chosen.length === 1) await chosen[0].click();
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
        good = /phone|tel/.test(`${f.name} ${f.id} ${f.inputType}`.toLowerCase()) ? digits(String(v)).endsWith(digits(a.value).slice(-7)) && digits(a.value).length > 0 : norm(String(v)) === norm(a.value);
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
        good = a.values.every((x) => list.includes(norm(x)));
        break;
      case "search":
        good = list.some((x) => a.match.every((m) => x.includes(norm(m))));
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
  const out: string[] = [];
  for (const o of await visibleOptions(page)) {
    const t = ((await o.textContent({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
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
  for (const o of await visibleOptions(page)) {
    if (norm(await o.textContent({ timeout: 1000 }).catch(() => "")) === norm(label)) {
      await o.scrollIntoViewIfNeeded().catch(() => {});
      await o.click({ timeout: 4000 }).catch(() => o.click({ force: true, timeout: 4000 }));
      return true;
    }
  }
  return false;
}

async function closeMenu(page: Page, input?: Locator) {
  if (input && (await input.inputValue({ timeout: 1000 }).catch(() => ""))) await input.fill("").catch(() => {});
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
    await t.loc.click({ timeout: 5000 }).catch(() => t.loc.click({ force: true, timeout: 5000 }).catch(() => {}));
    await t.loc.fill("").catch(() => {});
    await t.loc.fill(query).catch(async () => {
      await t.loc.pressSequentially(query, { delay: 20 }).catch(() => {});
    });
    let labels = await waitOptions(page, 2500);
    if (!labels.length) {
      await t.loc.press("Enter").catch(() => {}); // prompts that search on Enter
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
        await again.loc.fill(pick).catch(() => {});
        await waitOptions(page, 2500);
        if (!(await clickOption(page, pick))) await again.loc.press("Enter").catch(() => {});
      }
      const ok = await until(3000, async () => {
        const now = await find();
        return !!now && o.committed(now.f, pick);
      });
      if (ok) {
        const now = await find();
        await closeMenu(page, now?.loc);
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
