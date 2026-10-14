import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Dialog, DialogContent, DialogFooter } from "./dialog";

/** Explicit confirmation for destructive actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  destructive = true,
  busy,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: React.ReactNode;
  body: React.ReactNode;
  confirmLabel?: React.ReactNode;
  onConfirm: () => unknown;
  destructive?: boolean;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} size="sm" role="alertdialog">
        <p className="text-[13px] text-ink-2">{body}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("actions.cancel")}
          </Button>
          <Button variant={destructive ? "danger" : "primary"} disabled={busy} onClick={() => void onConfirm()}>
            {confirmLabel ?? t("actions.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
