import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiRequestError } from "@/lib/api";

/** Maps API error codes to localized messages (never shows raw server text for unknown codes). */
export function useErrorMessage() {
  const { t, i18n } = useTranslation();
  return useCallback(
    (err: unknown) => {
      if (err instanceof ApiRequestError) {
        const key = `errors.${err.code}`;
        if (i18n.exists(key)) return t(key);
        const exKey = `extraction.errors.${err.code}`;
        if (i18n.exists(exKey)) return t(exKey);
      }
      // Unknown or internal errors: show the HTTP status and request id so the failure can be traced
      // in the Worker logs without exposing any server internals.
      if (err instanceof ApiRequestError && err.status > 0) {
        return t("errors.genericWithRef", { status: err.status, code: err.code, ref: err.requestId?.slice(0, 8) ?? "—" });
      }
      return t("errors.generic");
    },
    [t, i18n],
  );
}

export function useToastError() {
  const msg = useErrorMessage();
  return useCallback((err: unknown) => toast.error(msg(err)), [msg]);
}
