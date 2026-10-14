import type { PipelineStatus } from "@shared/constants";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useToastError } from "./useApiError";

export const JOB_QUERY_ROOTS = ["jobs", "board", "job", "dashboard", "analytics", "calendar", "events", "reminders", "nav-counts", "compare", "extraction", "documents", "match", "apply"];

export function useInvalidateJobs() {
  const qc = useQueryClient();
  return () => Promise.all(JOB_QUERY_ROOTS.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

export function useStatusMutation() {
  const { t } = useTranslation();
  const invalidate = useInvalidateJobs();
  const onError = useToastError();
  return useMutation({
    mutationFn: (v: { id: string; status: PipelineStatus; occurred_at?: number | null; note?: string | null }) =>
      api.post<{ changed: boolean; to: PipelineStatus }>(`/api/jobs/${v.id}/status`, { status: v.status, occurred_at: v.occurred_at ?? undefined, note: v.note ?? undefined }),
    onSuccess: (res) => {
      if (res.changed) toast.success(t("job.statusDialog.changed", { status: t(`status.${res.to}`) }));
      void invalidate();
    },
    onError,
  });
}
