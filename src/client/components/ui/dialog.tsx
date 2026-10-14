import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  size = "md",
  ...props
}: Omit<React.ComponentProps<typeof D.Content>, "title"> & { title: React.ReactNode; description?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl" }) {
  const { t } = useTranslation();
  const width = { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" }[size];
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-ink/25 backdrop-blur-[1px] data-[state=open]:animate-in" />
      <D.Content
        className={cn(
          "fixed z-50 inset-x-0 bottom-0 sm:inset-auto sm:left-1/2 sm:top-[8vh] sm:-translate-x-1/2 w-full max-h-[92vh] sm:max-h-[84vh] flex flex-col rounded-t-xl sm:rounded-xl border border-line bg-surface shadow-pop focus:outline-none",
          width,
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <D.Title className="text-[15px] font-semibold text-ink">{title}</D.Title>
            {description ? <D.Description className="mt-0.5 text-xs text-ink-3">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
          </div>
          <D.Close className="-mr-1 rounded-md p-1 text-ink-3 hover:bg-subtle hover:text-ink" aria-label={t("actions.close")}>
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="overflow-y-auto scrollbar-thin px-5 py-4">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("-mx-5 -mb-4 mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/60 px-5 py-3 sticky bottom-[-16px]", className)}>{children}</div>;
}
