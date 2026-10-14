// In-page scripts run by Playwright inside the application page. Plain JavaScript strings so no
// bundler helper can leak into the page. They only READ the form (and tag controls with a
// data-ca-ref attribute so the worker can address them); they never send anything anywhere.

/** Returns FieldDescriptor[] (see plan.ts) for the form controls in `root` (default: document). */
export const SCAN_FIELDS = String.raw`(() => {
  const root = document.querySelector('form#application-form, form#application_form, form.application-form, form[data-qa="application-form"]') || document;
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
  const container = (el) => el.closest('.field, .application-question, .application-field, .form-field, li, fieldset, [class*="question"], [class*="field"]');
  const labelFor = (el) => {
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
    return clean(head);
  };
  const isDemo = (el) => !!el.closest('#demographic-section, #eeoc_fields, .eeo-section, [class*="demographic"], [data-qa*="eeo"]') || /voluntary|self.identif|demographic|equal employment|eeo/i.test(sectionOf(el));
  const requiredOf = (el, label) => el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\*\s*\(|\(required\)/i.test(label) || !!(container(el) && container(el).querySelector('.required, [class*="required"], abbr[title="required"]'));
  const out = [];
  const seenGroups = new Set();
  const controls = root.querySelectorAll('input, select, textarea');
  for (const el of controls) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password'].includes(type)) continue;
    if (el.disabled || el.readOnly && type !== 'file') continue;
    if (el.closest('[aria-hidden="true"]') && type !== 'file') continue;
    const base = { inputType: type, name: el.name || '', id: el.id || '', placeholder: clean(el.getAttribute('placeholder')), autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(), section: sectionOf(el), demographic: isDemo(el), options: [] };
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
      out.push({ ...base, ref: ref(el), control: 'file', label, required: requiredOf(el, label), value: [...(el.files || [])].map((f) => f.name), visible: true });
      continue;
    }
    if (el.tagName === 'SELECT') {
      const opts = [...el.options].map((o) => ({ value: o.value, label: clean(o.textContent) }));
      out.push({ ...base, ref: ref(el), control: 'select', label, required: requiredOf(el, label), options: opts, value: el.selectedIndex >= 0 && el.value ? [clean(el.options[el.selectedIndex].textContent)] : [], visible: visible(el) });
      continue;
    }
    if (el.getAttribute('role') === 'combobox' || el.closest('.select__control, [class*="select__control"]')) {
      const ctl = el.closest('.select__control, [class*="-control"], [class*="select__control"]') || el.parentElement;
      const single = ctl && ctl.querySelector('.select__single-value, [class*="singleValue"], [class*="single-value"]');
      const multi = ctl ? [...ctl.querySelectorAll('.select__multi-value__label, [class*="multiValue"] [class*="label"]')].map(textOf) : [];
      out.push({ ...base, ref: ref(el), control: 'combobox', label, required: requiredOf(el, label), value: single ? [textOf(single)] : multi, visible: visible(ctl || el) });
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
  const challenge = frames.some((f) => /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*(challenge|frame=challenge)|challenges\.cloudflare\.com/i.test(f.src || '') && vis(f))
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
    leverForm: !!document.querySelector('form input[name="resume"]#resume-upload-input, form#application-form input[name="name"][data-qa="name-input"], .application-page form input[name="urls[LinkedIn]"]'),
  };
})()`;
