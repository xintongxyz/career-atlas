import type { MeDTO } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import type { Lang } from "@/lib/format";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api.get<MeDTO>("/api/me"), staleTime: 5 * 60_000 });
}

/** Display context: active UI language + the user's time zone. */
export function useLocaleContext() {
  const { i18n, t } = useTranslation();
  const me = useMe();
  const lang = (i18n.language === "zh-CN" ? "zh-CN" : "en") as Lang;
  const tz = me.data?.preferences.timezone ?? "America/Toronto";
  return { t, lang, tz, me: me.data };
}
