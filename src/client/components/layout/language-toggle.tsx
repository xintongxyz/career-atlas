import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Segmented } from "@/components/ui/tabs";
import { api } from "@/lib/api";

/** EN / 中文 switch. Changes the UI instantly (no state loss) and saves the preference. */
export function LanguageToggle({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (locale: string) => api.patch("/api/me/preferences", { locale }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const value = i18n.language === "zh-CN" ? "zh-CN" : "en";
  return (
    <Segmented
      className={className}
      label="Language / 语言"
      value={value}
      onChange={(v) => {
        void i18n.changeLanguage(v);
        save.mutate(v);
      }}
      options={[
        { value: "en", label: "EN" },
        { value: "zh-CN", label: "中文" },
      ]}
    />
  );
}
