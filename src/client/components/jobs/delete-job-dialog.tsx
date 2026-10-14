import { useMutation, useQuery } from "@tanstack/react-query";
import { Archive, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Checkbox, Spinner } from "@/components/ui/misc";
import { useErrorMessage } from "@/hooks/useApiError";
import { api } from "@/lib/api";

type Impact = { application: boolean; events: number; notes: number; reminders: number; snapshots: number; linked_documents: number };

/**
 * Permanent deletion with an explicit impact summary and acknowledgement.
 * Archive is offered first because it is reversible and keeps all history.
 */
export function DeleteJobDialog({ jobId, title, open, onOpenChange, onArchive, onDeleted }: { jobId: string; title: string; open: boolean; onOpenChange: (o: boolean) => void; onArchive: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const errMsg = useErrorMessage();
  const [ack, setAck] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setAck(false);
      setError(null);
    }
  }, [open]);
  const impact = useQuery({ queryKey: ["job", jobId, "delete-impact"], queryFn: () => api.get<Impact>(`/api/jobs/${jobId}/delete-impact`), enabled: open });
  const del = useMutation({ mutationFn: () => api.delete(`/api/jobs/${jobId}`), onSuccess: onDeleted, onError: (e) => setError(errMsg(e)) });
  const i = impact.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("job.deleteTitle")} description={title} size="sm" role="alertdialog">
        <div className="space-y-3 text-[13px] text-ink-2">
          <p>{t("job.deleteBody")}</p>
          {impact.isLoading ? (
            <Spinner />
          ) : i ? (
            <ul className="list-disc space-y-0.5 rounded-md bg-subtle py-2 pl-7 pr-3 text-xs">
              {i.application ? <li>{t("job.deleteImpact.application")}</li> : null}
              <li>{t("job.deleteImpact.events", { count: i.events })}</li>
              <li>{t("job.deleteImpact.notes", { count: i.notes })}</li>
              <li>{t("job.deleteImpact.reminders", { count: i.reminders })}</li>
              <li>{t("job.deleteImpact.snapshots", { count: i.snapshots })}</li>
              {i.linked_documents ? <li>{t("job.deleteImpact.documents", { count: i.linked_documents })}</li> : null}
            </ul>
          ) : null}
          <p className="text-xs text-ink-3">{t("job.deleteKeeps")}</p>
          <label className="flex items-start gap-2 text-[13px]">
            <Checkbox className="mt-0.5" checked={ack} onCheckedChange={(v) => setAck(!!v)} />
            {t("job.deleteAck")}
          </label>
          {error ? (
            <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
              onArchive();
            }}
          >
            <Archive />
            {t("job.archiveInstead")}
          </Button>
          <Button variant="danger" disabled={!ack || del.isPending} onClick={() => del.mutate()}>
            <Trash2 />
            {del.isPending ? t("actions.saving") : t("job.deletePermanently")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
