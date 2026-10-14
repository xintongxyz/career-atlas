import { describe, expect, it } from "vitest";
import { hasTranslation, isOriginalLanguage, localizePosting, localizedTitle } from "../../src/client/lib/job-i18n";
import type { JobTranslations } from "../../src/shared/types";

const translations: JobTranslations = { source: "ai", generated_at: 1, values: { "zh-CN": { title: "数据分析师", responsibilities: ["构建仪表盘"], benefits: ["不应出现"] }, en: { title: "Data Analyst" } } };
const posting = { title: "Data Analyst", content_language: "en", responsibilities: ["Build dashboards"], benefits: [] as string[], translations };

describe("bilingual job display", () => {
  it("shows the translation in the other language and the original in the posting's language", () => {
    expect(localizePosting(posting, "zh-CN")).toEqual({ posting: { ...posting, title: "数据分析师", responsibilities: ["构建仪表盘"] }, translated: ["title", "responsibilities"] });
    expect(localizePosting(posting, "en")).toEqual({ posting, translated: [] });
  });
  it("never adds content the original does not have, and falls back to the original", () => {
    expect(localizePosting(posting, "zh-CN").posting.benefits).toEqual([]);
    expect(localizePosting({ ...posting, translations: null }, "zh-CN").posting.title).toBe("Data Analyst");
  });
  it("treats en-US/zh-Hans as the same language family", () => {
    expect(isOriginalLanguage("en-US", "en")).toBe(true);
    expect(isOriginalLanguage("zh-Hans", "zh-CN")).toBe(true);
    expect(isOriginalLanguage(null, "en")).toBe(false);
  });
  it("list titles use title_translations", () => {
    const item = { title: "Data Analyst", content_language: "en", title_translations: { "zh-CN": "数据分析师" } };
    expect(localizedTitle(item, "zh-CN")).toBe("数据分析师");
    expect(localizedTitle(item, "en")).toBe("Data Analyst");
    expect(localizedTitle({ ...item, title_translations: null }, "zh-CN")).toBe("Data Analyst");
    expect(hasTranslation(posting, "zh-CN")).toBe(true);
    expect(hasTranslation(posting, "en")).toBe(false);
  });
});
