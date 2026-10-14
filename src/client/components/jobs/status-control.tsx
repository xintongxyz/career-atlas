import { PIPELINE_STATUSES, SAVED_STAGES, type PipelineStatus } from "@shared/constants";
import { ChevronDown } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useLocaleContext } from "@/hooks/useMe";
import { useStatusMutation } from "@/hooks/useJobMutations";
import { fromDateTimeInput, toDateTimeInput } from "@/lib/format";
import { STATUS_DOT, StatusBadge } from "./badges";

const GROUPS: { key: string; statuses: PipelineStatus[] }[] = [
  { key: "pre", statuses: ["saved", "preparing"] },
  { key: "active", statuses: ["applied", "awaiting_response", "assessment", "interview", "offer"] },
  { key: "outcome", statuses: ["accepted", "rejected", "withdrawn", "closed"] },
  { key: "other", statuses: ["archived"] },
];

/** Status dropdown. Choosing a status opens a dialog to confirm the date (history-accurate). */
export function StatusControl({ jobId, status, hasApplication, size = "md" }: { jobId: string; status: PipelineStatus; hasApplication: boolean; size?: "sm" | "md" }) {
  const { t } = useTranslation();
  const [target, setTarget] = React.useState<PipelineStatus | null>(null);
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="secondary" size={size} aria-label={t("actions.changeStatus")}>
            <StatusBadge status={status} className="bg-transparent px-0" />
            <ChevronDown className="text-ink-4" />
          </Button>
        </MenuTrigger>
        <MenuContent align="start" className="w-56">
          {GROUPS.map((g, i) => (
            <React.Fragment key={g.key}>
              {i > 0 ? <MenuSeparator /> : null}
              <MenuLabel>{t(`statusGroup.${g.key}`)}</MenuLabel>
              {g.statuses.map((s) => {
                const blocked = hasApplication && (SAVED_STAGES as readonly string[]).includes(s) && s !== "closed";
                return (
                  <MenuItem key={s} disabled={s === status || blocked} onSelect={() => setTarget(s)} title={blocked ? t("job.statusDialog.backwardsBlocked") : undefined}>
                    <span className={`size-2 rounded-full ${STATUS_DOT[s]}`} aria-hidden />
                    {t(`status.${s}`)}
                  </MenuItem>
                );
              })}
            </React.Fragment>
          ))}
        </MenuContent>
      </Menu>
      <StatusDialog jobId={jobId} target={target} onClose={() => setTarget(null)} />
    </>
  );
}

export function StatusDialog({ jobId, target, onClose, onDone }: { jobId: string; target: PipelineStatus | null; onClose: () => void; onDone?: () => void }) {
  const { t, tz, me } = useLocaleContext();
  const mutation = useStatusMutation();
  const [when, setWhen] = React.useState("");
  const [note, setNote] = React.useState("");
  React.useEffect(() => {
    if (target) {
      setWhen(toDateTimeInput(Date.now(), tz));
      setNote("");
    }
  }, [target, tz]);
  if (!PIPELINE_STATUSES.includes(target as PipelineStatus) && target !== null) return null;
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t("job.statusDialog.title")} description={target ? t(`status.${target}`) : undefined} size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!target) return;
            mutation.mutate(
              { id: jobId, status: target, occurred_at: fromDateTimeInput(when, tz), note: note || null },
              {
                onSuccess: () => {
                  onClose();
                  onDone?.();
                },
              },
            );
          }}
          className="space-y-3"
        >
          <Field label={t("job.statusDialog.date")} htmlFor="status-when" hint={target === "applied" ? t("job.statusDialog.appliedHint", { days: me?.preferences.default_follow_up_days ?? 7 }) : undefined}>
            <Input id="status-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required max={toDateTimeInput(Date.now() + 86_400_000, tz)} />
          </Field>
          <Field label={t("job.statusDialog.note")} htmlFor="status-note">
            <Textarea id="status-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={mutation.isPending}>
              {mutation.isPending ? t("actions.saving") : t("actions.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
