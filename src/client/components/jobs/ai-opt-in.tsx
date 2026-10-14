import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMe } from "@/hooks/useMe";

/** True when the optional AI provider (Claude Code) is enabled. AI always runs only on request. */
export function useAiOnRequest() {
  return !!useMe().data?.config.ai_enabled;
}

/**
 * Opt-in checkbox for AI-assisted extraction. Rendered only when AI is enabled; states
 * plainly that the posting is sent to an online service and uses the Claude plan's allowance.
 */
export function AiOptIn({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id: string }) {
  const { t } = useTranslation();
  if (!useAiOnRequest()) return null;
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
      <input id={id} type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="flex items-center gap-1 font-medium text-ink">
          <Sparkles className="size-3.5 text-accent" aria-hidden />
          {t("ai.optInLabel")}
        </span>
        <span className="block text-xs text-ink-3">{t("ai.optInHelp")}</span>
      </span>
    </label>
  );
}
