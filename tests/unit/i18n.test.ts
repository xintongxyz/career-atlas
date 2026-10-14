import { describe, expect, it } from "vitest";
import en from "../../src/client/i18n/locales/en";
import zhCN from "../../src/client/i18n/locales/zh-CN";

type Tree = { [k: string]: string | Tree };
function flatten(t: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  const e = flatten(en as unknown as Tree);
  const z = flatten(zhCN as unknown as Tree);
  // English-only plural forms (`_one`) fall back to the base key in Chinese, which has no plural forms.
  const enKeys = Object.keys(e).filter((k) => !k.endsWith("_one"));

  it("zh-CN has every English key and no extras", () => {
    expect(enKeys.filter((k) => !(k in z))).toEqual([]);
    expect(Object.keys(z).filter((k) => !(k in e))).toEqual([]);
  });
  it("keeps interpolation placeholders identical", () => {
    const bad = enKeys.filter((k) => z[k] !== undefined && JSON.stringify(placeholders(e[k])) !== JSON.stringify(placeholders(z[k])));
    expect(bad).toEqual([]);
  });
  it("has no empty Chinese strings except intentional ones", () => {
    const empty = Object.entries(z).filter(([k, v]) => v === "" && e[k] !== "").map(([k]) => k);
    expect(empty).toEqual([]);
  });
  it("does not add spaces between Chinese and Latin characters or digits", () => {
    const spaced = Object.entries(z).filter(([, v]) => /[一-鿿] [A-Za-z0-9]|[A-Za-z0-9] [一-鿿]/.test(v.replace(/\{\{\w+\}\}/g, "")));
    expect(spaced.map(([k]) => k)).toEqual([]);
  });
});
