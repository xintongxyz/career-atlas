import { Loader2 } from "lucide-react";
import { Checkbox as C } from "radix-ui";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-line bg-surface shadow-card", className)} {...props} />;
}

export function CardHeader({ title, action, description, className }: { title: React.ReactNode; action?: React.ReactNode; description?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pt-3.5 pb-2", className)}>
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-ink-3">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

type Tone = "neutral" | "accent" | "info" | "warn" | "danger" | "ok" | "violet" | "outline";
const toneClass: Record<Tone, string> = {
  neutral: "bg-subtle text-ink-2",
  accent: "bg-accent-soft text-accent",
  info: "bg-info-soft text-info",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  ok: "bg-ok-soft text-ok",
  violet: "bg-violet-soft text-violet",
  outline: "border border-line text-ink-2 bg-surface",
};

export function Badge({ tone = "neutral", className, children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium leading-4 [&_svg]:size-3", toneClass[tone], className)} {...props}>
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-subtle", className)} />;
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <Loader2 className={cn("size-4 animate-spin text-ink-3", className)} aria-hidden />
      {label ? <span className="text-xs text-ink-3">{label}</span> : <span className="sr-only">{t("app.loading")}</span>}
    </span>
  );
}

export function EmptyState({ icon, title, body, action, className }: { icon?: React.ReactNode; title: React.ReactNode; body?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon ? <div className="mb-3 rounded-full bg-subtle p-3 text-ink-3 [&_svg]:size-5">{icon}</div> : null}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {body ? <p className="mt-1 max-w-md text-[13px] text-ink-3">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry, retryLabel }: { message: React.ReactNode; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <p className="text-[13px] text-ink-2">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="text-[13px] font-medium text-accent hover:underline">
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export const Checkbox = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof C.Root>>(({ className, ...props }, ref) => (
  <C.Root
    ref={ref}
    className={cn(
      "peer inline-flex size-4 shrink-0 items-center justify-center rounded border border-line-strong bg-surface transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
      className,
    )}
    {...props}
  >
    <C.Indicator className="text-accent-ink">
      {props.checked === "indeterminate" ? (
        <svg viewBox="0 0 12 12" className="size-2.5"><path d="M2.5 6h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      ) : (
        <svg viewBox="0 0 12 12" className="size-2.5"><path d="m2.5 6.2 2.3 2.3 4.7-4.9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      )}
    </C.Indicator>
  </C.Root>
));
Checkbox.displayName = "Checkbox";

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-subtle px-1 font-mono text-[10px] text-ink-3">{children}</kbd>;
}

export function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("text-[11px] font-semibold uppercase tracking-wider text-ink-4", className)}>{children}</h3>;
}
