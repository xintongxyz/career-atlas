import { AlertCircle, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSaveStatus } from "@/lib/save-state";
import { cn } from "@/lib/utils";

/** Global autosave state: every change is written to the local database as you make it. */
export function SaveIndicator() {
  const { t } = useTranslation();
  const status = useSaveStatus();
  if (status === "idle") return null;
  const Icon = status === "saving" ? Loader2 : status === "error" ? AlertCircle : Check;
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="save-status"
      data-state={status}
      className={cn("flex items-center gap-1 text-xs", status === "error" ? "text-danger" : "text-ink-4")}
      title={status === "error" ? t("save.failedHelp") : undefined}
    >
      <Icon className={cn("size-3.5", status === "saving" && "animate-spin")} aria-hidden />
      <span className="max-sm:sr-only">{t(`save.${status}`)}</span>
    </span>
  );
}
