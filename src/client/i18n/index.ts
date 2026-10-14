import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

export const SUPPORTED = ["en", "zh-CN"] as const;
export type AppLang = (typeof SUPPORTED)[number];
const STORAGE_KEY = "career-atlas.lang";

function initialLanguage(): AppLang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch {
    /* storage unavailable */
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

function applyDocumentLang(lang: string) {
  document.documentElement.lang = lang;
}
applyDocumentLang(i18n.language);
i18n.on("languageChanged", (lang) => {
  applyDocumentLang(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
});

export default i18n;
