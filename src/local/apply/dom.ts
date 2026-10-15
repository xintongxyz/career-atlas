// In-page scripts run by Playwright inside the application page. Plain JavaScript strings so no
// bundler helper can leak into the page. They only READ the form (and tag controls with a
// data-ca-ref attribute so the worker can address them); they never send anything anywhere.

/** Returns FieldDescriptor[] (see plan.ts) for the form controls in `root` (default: document). */
export const SCAN_FIELDS = String.raw`(() => {
  const root = document.querySelector('form#application-form, form#application_form, form.application-form, form[data-qa="application-form"], [data-automation-id="applyFlowPage"]') || document;
  let n = Number(document.documentElement.getAttribute('data-ca-seq') || 0);
  const ref = (el) => {
    if (!el.getAttribute('data-ca-ref')) { n += 1; el.setAttribute('data-ca-ref', 'f' + n); }
    return el.getAttribute('data-ca-ref');
  };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const textOf = (el) => {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll('input,select,textarea,button,svg,[aria-hidden="true"],.visually-hidden').forEach((x) => x.remove());
    return clean(c.textContent);
  };
  const byIds = (ids) => clean((ids || '').split(/\s+/).map((i) => textOf(document.getElementById(i))).join(' '));
  // Workday: every control sits in [data-automation-id="formField-<name>"] with its label.
  const wdField = (el) => el.closest('[data-automation-id^="formField-"]');
  const wdName = (el) => { const f = wdField(el); return f ? f.getAttribute('data-automation-id').slice(10) : ''; };
  const container = (el) => wdField(el) || el.closest('.field, .application-question, .application-field, .form-field, li, fieldset, [class*="question"], [class*="field"]');
  const wdLabel = (el) => { const f = wdField(el); if (!f) return ''; const l = f.querySelector('label, legend'); return l ? textOf(l) : ''; };
  // Workday repeating sections (work experience, education, websites, languages, certifications) and
  // the skills tag box. A control belongs to a panel when (in this order):
  //   1. an ancestor is marked data-automation-id="<prefix>-<n>" (e.g. "education-2"), or
  //   2. its id is "<prefix>-<n>--<field>" (live Workday: n is an internal counter, not a position), or
  //   3. it sits under a section heading ("Websites", "Languages", …) inside a block holding exactly
  //      one Delete/Remove button.
  // groupIndex is the panel's POSITION among the section's panels on the page (0-based).
  const GROUP_OF = { workexperience: 'work', education: 'education', webaddress: 'websites', website: 'websites', websites: 'websites', language: 'languages', languages: 'languages', certification: 'certifications', certifications: 'certifications', licensecertification: 'certifications' };
  const SECTION_RE = [[/^(work )?experience$|^work experience|^employment( history)?$/i, 'work'], [/^education/i, 'education'], [/^(web ?sites?|social network|links?|urls?)\b/i, 'websites'], [/^languages?\b/i, 'languages'], [/^skills?\b/i, 'skills'], [/^(certifications?|licen[cs]es?)\b/i, 'certifications']];
  const HEAD_SEL = 'h1,h2,h3,h4,h5,legend,[role="heading"]';
  const headingOf = (el) => {
    let a = el.parentElement;
    for (let d = 0; a && d < 12 && a !== document.body; d++, a = a.parentElement) {
      const hs = [...a.querySelectorAll(HEAD_SEL)].filter((h) => !h.contains(el) && (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      for (let i = hs.length - 1; i >= 0; i--) {
        const t = textOf(hs[i]);
        if (t && !/^(work experience|education|websites?|languages?|certifications?) \d+$/i.test(t)) return t;
      }
    }
    return '';
  };
  const groupOfHeading = (h) => { for (const [re, g] of SECTION_RE) if (re.test(h)) return g; return null; };
  const idNums = {};
  const idOrder = (prefix, num) => {
    if (!idNums[prefix]) {
      const seen = [];
      for (const x of document.querySelectorAll('[id^="' + prefix + '-"]')) { const m = x.id.match(/^[A-Za-z]+-(\d+)--/); if (m && !seen.includes(m[1])) seen.push(m[1]); }
      idNums[prefix] = seen;
    }
    return idNums[prefix].indexOf(num);
  };
  const DEL_RE = /^(delete|remove)\b/i;
  const panelBlocks = new Map();
  const panelCount = {};
  const panelOf = (el) => {
    const gid = (el.id || '').match(/(workHistory|educationHistory|websites|languages)_(\d+)_/i);
    if (gid) {
      const map = { workhistory: 'work', educationhistory: 'education', websites: 'websites', languages: 'languages' };
      return { group: map[gid[1].toLowerCase()], groupIndex: Number(gid[2]) };
    }
    let a = el;
    while (a && a !== document.body) {
      const m = (a.getAttribute && a.getAttribute('data-automation-id') || '').match(/^([A-Za-z]+)-(\d+)$/);
      const g = m && GROUP_OF[m[1].toLowerCase()];
      if (g) {
        const all = [...document.querySelectorAll('[data-automation-id^="' + m[1] + '-"]')].filter((x) => new RegExp('^' + m[1] + '-\\d+$').test(x.getAttribute('data-automation-id')));
        return { group: g, groupIndex: all.indexOf(a) };
      }
      a = a.parentElement;
    }
    const idm = (el.id || '').match(/^([A-Za-z]+)-(\d+)--/);
    if (idm && GROUP_OF[idm[1].toLowerCase()]) return { group: GROUP_OF[idm[1].toLowerCase()], groupIndex: idOrder(idm[1], idm[2]) };
    // Other systems number repeated rows inside the field name: "…_workHistory_0_title",
    // "education[1][school]", "employment-2-employer". The number is the row's position.
    const rowm = ((el.id || '') + ' ' + (el.name || '')).match(/(?:^|[_.\[\s-])(work_?history|employment_?history|employment|experience|work_?experience|education_?history|education|schools?|websites?|languages?)[_.\[-]+(\d+)[\]_.-]/i);
    if (rowm) {
      const k = rowm[1].toLowerCase().replace(/_/g, '');
      const g = /work|employ|experience/.test(k) ? 'work' : /educ|school/.test(k) ? 'education' : /web/.test(k) ? 'websites' : 'languages';
      return { group: g, groupIndex: Number(rowm[2]) };
    }
    // Repeated blocks marked by their container ("employment-form", "education--form", …) with the
    // entry number at the end of the field id ("company-name-0", "school--1", "current-role-0_1").
    const blk = el.closest('[class*="employment" i], [id*="employment" i], [class*="education" i], [id*="education" i], [class*="experience" i], [id*="experience" i]');
    const tail = ((el.id || '') + ' ' + (el.name || '')).match(/(?:-|_|--)(\d+)(?:_\d+)?(?:\]|\s|$)/);
    if (blk && blk !== document.body && tail && Number(tail[1]) < 50 && !blk.matches('form#application-form, form#application_form, form')) {
      const k = String(blk.className || '') + ' ' + (blk.id || '');
      const g = /educ/i.test(k) ? 'education' : 'work';
      return { group: g, groupIndex: Number(tail[1]) };
    }
    if (wdName(el) === 'skills') return { group: 'skills', groupIndex: 0 };
    const g = groupOfHeading(headingOf(el));
    if (g === 'skills') return { group: 'skills', groupIndex: 0 };
    if (g) {
      let b = el.parentElement;
      for (let d = 0; b && d < 8 && b !== document.body; d++, b = b.parentElement) {
        const dels = [...b.querySelectorAll('button')].filter((x) => DEL_RE.test(clean(x.getAttribute('aria-label') || x.textContent)));
        if (dels.length === 1) {
          if (!panelBlocks.has(b)) { panelCount[g] = (panelCount[g] || 0) + 1; panelBlocks.set(b, panelCount[g] - 1); }
          return { group: g, groupIndex: panelBlocks.get(b) };
        }
        if (dels.length > 1) break;
      }
    }
    return { group: null, groupIndex: null };
  };
  // Field name: Workday's formField-<name>, else the id suffix ("education-4--degree" → "degree").
  const fieldName = (el) => wdName(el) || ((el.id || '').match(/--([A-Za-z]+)$/) || [])[1] || '';
  const labelFor = (el) => {
    const w = wdLabel(el);
    if (w) return w;
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && textOf(l)) return textOf(l);
    }
    if (el.getAttribute('aria-labelledby')) { const t = byIds(el.getAttribute('aria-labelledby')); if (t) return t; }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return textOf(wrap);
    const fs = el.closest('fieldset');
    if (fs && fs.querySelector('legend')) return textOf(fs.querySelector('legend'));
    const c = container(el);
    if (c) {
      const l = c.querySelector('label, .application-label, .label, [class*="label"], legend');
      if (l && textOf(l)) return textOf(l);
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || '');
  };
  const sectionOf = (el) => {
    const sec = el.closest('section, fieldset, [id*="section"], [class*="section"]');
    let head = '';
    if (sec) { const h = sec.querySelector('h1,h2,h3,h4,legend'); if (h) head = textOf(h); head += ' ' + (sec.id || ''); }
    return clean(head) || headingOf(el);
  };
  const isDemo = (el) => !!el.closest('#demographic-section, #eeoc_fields, .eeo-section, [class*="demographic"], [data-qa*="eeo"], [data-automation-id="applyFlowVoluntaryDisclosuresPage"], [data-automation-id="applyFlowSelfIdentifyPage"], [data-automation-id="voluntaryDisclosuresPage"], [data-automation-id="selfIdentificationPage"]') || /voluntary|self.identif|demographic|equal employment|eeo/i.test(sectionOf(el));
  const requiredOf = (el, label) => el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\*\s*\(|\(required\)/i.test(label) || !!(container(el) && container(el).querySelector('.required, [class*="required"], abbr[title="required"]'));
  const out = [];
  const seenGroups = new Set();
  const seenDates = new Set();
  const controls = root.querySelectorAll('input, select, textarea, button[aria-haspopup="listbox"]');
  for (const el of controls) {
    const type = el.tagName === 'BUTTON' ? 'listbox' : (el.getAttribute('type') || el.tagName).toLowerCase();
    // (type="search" is kept: Workday's searchable prompts and the skills box may use it.)
    if (['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(type)) continue;
    if (el.id === 'lang-select' || el.name === 'g-recaptcha-response' || el.id === 'g-recaptcha-response') continue;
    // Never touch honeypots ("for robots only") or sign-in / account forms.
    if (el.closest('[data-automation-id="beecatcher"]') || el.getAttribute('data-automation-id') === 'beecatcher') continue;
    if (el.closest('[data-automation-id="signInContent"], form[data-automation-id^="signInForm"]')) continue;
    if (el.closest('[data-automation-id="selectedItemList"]')) continue;
    // Not part of the application: site search, job-alert sign-ups, cookie banners, site chrome (page-intent.ts).
    if (el.closest('[data-ca-outside]')) continue;
    // Ant Design marks searchable selects read-only until they open. They are still fields.
    // A disabled control (for example State before Country) stays skipped until it is enabled.
    if (el.disabled) continue;
    if (el.readOnly && type !== 'file' && el.getAttribute('role') !== 'combobox' && !el.closest('.ant-select')) continue;
    if (el.closest('[aria-hidden="true"]') && type !== 'file') continue;
    const panel = panelOf(el);
    const invalid = el.getAttribute('aria-invalid') === 'true' || !!(wdField(el) && wdField(el).querySelector('[data-automation-id="inputAlert"], [data-automation-id="errorMessage"]'));
    const base = { invalid, inputType: type, name: el.name || fieldName(el), id: el.id || '', placeholder: clean(el.getAttribute('placeholder')), autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(), section: sectionOf(el), demographic: isDemo(el), options: [], wdField: fieldName(el), group: panel.group, groupIndex: panel.groupIndex };
    // Workday date: month / day / year inputs typed separately -> one field.
    const dai = el.getAttribute('data-automation-id') || '';
    const datePart = (dai.match(/^dateSection(Month|Day|Year)-input$/) || [])[1];
    if (datePart) {
      const wrap = el.closest('[data-automation-id="dateInputWrapper"]') || wdField(el) || el.parentElement;
      if (seenDates.has(wrap)) continue;
      seenDates.add(wrap);
      const parts = {};
      const vals = [];
      for (const p of ['Month', 'Day', 'Year']) {
        const i = wrap.querySelector('[data-automation-id="dateSection' + p + '-input"]');
        if (i) { parts[p.toLowerCase()] = ref(i); if (i.value) vals.push(i.value); }
      }
      const label = labelFor(el);
      out.push({ ...base, inputType: 'date', ref: ref(el), control: 'date', label, required: requiredOf(el, label), parts, value: vals.join('/'), visible: visible(wrap) });
      continue;
    }
    if (type === 'listbox') {
      const label = labelFor(el);
      const t = clean(el.textContent);
      out.push({ ...base, ref: ref(el), control: 'listbox', label, required: requiredOf(el, label), value: t && !/^select one$/i.test(t) ? [t] : [], visible: visible(el) });
      continue;
    }
    // Workday searchable multiselect ("prompt"): chosen values are shown as selectedItem chips.
    const MS = '[data-automation-id="multiselectInputContainer"], [data-automation-id="multiSelectContainer"], [data-uxi-widget-type="multiselect"], [data-uxi-widget-type="selectinput"]';
    if (el.closest(MS) || el.getAttribute('data-automation-id') === 'searchBox' || (type === 'search' && wdField(el))) {
      const label = labelFor(el);
      const holder = wdField(el) || el.closest(MS) || el.parentElement;
      const chips = [...holder.querySelectorAll('[data-automation-id="selectedItem"]')].map(textOf).filter(Boolean);
      out.push({ ...base, ref: ref(el), control: 'combobox', asyncOptions: true, label, required: requiredOf(el, label), value: chips, visible: visible(el) || visible(holder) });
      continue;
    }
    // Ant Design (and similar) searchable selects: the input is only the search box; the chosen
    // text lives in .ant-select-selection-item. Options load after typing.
    if (el.closest('.ant-select')) {
      const label = labelFor(el);
      const holder = el.closest('.ant-select');
      const selected = holder ? textOf(holder.querySelector('.ant-select-selection-item')) : '';
      out.push({ ...base, ref: ref(el), control: 'combobox', asyncOptions: true, label, required: requiredOf(el, label), value: selected ? [selected] : [], visible: visible(el) || (holder ? visible(holder) : false) });
      continue;
    }
    if (type === 'radio' || (type === 'checkbox' && el.name && (el.name.endsWith('[]') || root.querySelectorAll('input[type="checkbox"][name="' + CSS.escape(el.name) + '"]').length > 1))) {
      const gname = el.name || el.id;
      if (seenGroups.has(type + gname)) continue;
      seenGroups.add(type + gname);
      const items = [...root.querySelectorAll('input[type="' + type + '"][name="' + CSS.escape(el.name) + '"]')];
      const fs = el.closest('fieldset');
      const c = container(el);
      let label = '';
      if (fs && fs.querySelector('legend')) label = textOf(fs.querySelector('legend'));
      else if (c) { const l = c.querySelector('.application-label, legend, [class*="label"]:not(label), label:not(:has(input))'); label = textOf(l); }
      if (!label) label = clean(el.getAttribute('aria-label') || gname);
      const opts = items.map((i) => {
        let t = '';
        if (i.id) { const l = document.querySelector('label[for="' + CSS.escape(i.id) + '"]'); if (l) t = textOf(l); }
        if (!t && i.closest('label')) t = textOf(i.closest('label'));
        if (!t && i.nextElementSibling) t = textOf(i.nextElementSibling);
        return { value: i.value, label: t || i.value, ref: ref(i) };
      });
      const checked = items.filter((i) => i.checked).map((i) => opts[items.indexOf(i)].label);
      out.push({ ...base, ref: ref(el), control: type === 'radio' ? 'radio' : 'checkboxes', label, required: items.some((i) => i.required) || requiredOf(el, label), options: opts, value: checked, visible: items.some(visible) || (c ? visible(c) : false) });
      continue;
    }
    const label = labelFor(el);
    if (type === 'file') {
      const wrap = el.closest('.ant-upload-wrapper');
      const names = [...(el.files || [])].map((f) => f.name);
      if (wrap) {
        for (const item of wrap.querySelectorAll('.ant-upload-list-item-name')) {
          const t = textOf(item);
          if (t && !names.includes(t)) names.push(t);
        }
      }
      const button = wrap && wrap.querySelector('button, [role="button"]');
      out.push({ ...base, ref: ref(el), control: 'file', label, required: requiredOf(el, label), value: names, visible: !button || visible(button) || names.length > 0 });
      continue;
    }
    if (el.tagName === 'SELECT') {
      const opts = [...el.options].map((o) => ({ value: o.value, label: clean(o.textContent) }));
      out.push({ ...base, ref: ref(el), control: 'select', label, required: requiredOf(el, label), options: opts, value: el.selectedIndex >= 0 && el.value ? [clean(el.options[el.selectedIndex].textContent)] : [], visible: visible(el) });
      continue;
    }
    if (el.getAttribute('role') === 'combobox' || el.closest('.select__control, [class*="select__control"]')) {
      // Component-library selects show the chosen value NEXT TO the search input (whose own value stays
      // empty): react-select (single-value), Ant Design (selection-item), MUI, Headless/Radix-style.
      const ctl = el.closest('.select__control, [class*="-control"], [class*="select__control"], .ant-select, .ant-select-selector, [class*="MuiAutocomplete"], [class*="MuiSelect"]') || el.parentElement;
      const holder = (ctl && ctl.closest('.ant-select')) || ctl;
      const single = holder && holder.querySelector('.select__single-value, [class*="singleValue"], [class*="single-value"], .ant-select-single .ant-select-selection-item, .MuiSelect-select');
      const multi = holder ? [...holder.querySelectorAll('.select__multi-value__label, [class*="multiValue"] [class*="label"], .ant-select-selection-item-content, .MuiChip-label')].map(textOf).filter(Boolean) : [];
      const typed = (el.value || '').trim();
      const shownValue = single ? [clean(single.getAttribute('title') || textOf(single))] : multi.length ? multi : (el.getAttribute('aria-autocomplete') === 'none' && typed ? [typed] : []);
      out.push({ ...base, ref: ref(el), control: 'combobox', label, required: requiredOf(el, label), value: shownValue, visible: visible(ctl || el) });
      continue;
    }
    if (type === 'checkbox') {
      out.push({ ...base, ref: ref(el), control: 'checkbox', label, required: requiredOf(el, label), value: el.checked, visible: visible(el) || (el.closest('label') ? visible(el.closest('label')) : false) });
      continue;
    }
    out.push({ ...base, ref: ref(el), control: el.tagName === 'TEXTAREA' ? 'textarea' : 'text', label, required: requiredOf(el, label), value: el.value, visible: visible(el) });
  }
  document.documentElement.setAttribute('data-ca-seq', String(n));
  return out;
})()`;

/** Page signals used to classify what the page is showing (see outcome.ts). */
export const PAGE_SIGNALS = String.raw`(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 40 && r.height > 40 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const frames = [...document.querySelectorAll('iframe')];
  // Bot checks: reCAPTCHA / hCaptcha challenges, Cloudflare, DataDome (captcha-delivery.com) — never bypassed.
  const challenge = frames.some((f) => /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*(challenge|frame=challenge)|challenges\.cloudflare\.com|captcha-delivery\.com|datadome/i.test(f.src || '') && vis(f))
    || [...document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[title*="challenge" i]')].some((e) => vis(e) && e.getBoundingClientRect().height > 60);
  const form = document.querySelector('form#application-form, form#application_form, form.application-form, form[data-qa="application-form"]');
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const errors = [...document.querySelectorAll('.error:not(:empty), .field-error, .error-message, [role="alert"], .application-error, [class*="error-text"], [class*="helper-text--error"]')]
    .filter(shown).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10);
  const invalid = [...document.querySelectorAll('[aria-invalid="true"]')].filter(shown).length;
  const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 20000);
  const password = [...document.querySelectorAll('input[type="password"]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const iframeGh = document.querySelector('iframe#grnhse_iframe, iframe[src*="greenhouse.io/embed/job_app"]');
  return {
    url: location.href,
    title: document.title,
    hasForm: !!form,
    formVisible: !!form && form.getBoundingClientRect().height > 0,
    challenge,
    password,
    errors,
    invalid,
    text,
    greenhouseIframe: iframeGh ? iframeGh.src : null,
    greenhouseForm: !!document.querySelector('form#application-form input#first_name, form#application_form input#first_name, #application_form [name="job_application[first_name]"]'),
    workday: !!document.querySelector('[data-automation-id="adventureButton"], [data-automation-id="applyFlowPage"], [data-automation-id="jobPostingHeader"], [data-automation-id="jobPostingPage"]'),
    leverForm: !!document.querySelector('form input[name="resume"]#resume-upload-input, form#application-form input[name="name"][data-qa="name-input"], .application-page form input[name="urls[LinkedIn]"]'),
  };
})()`;
