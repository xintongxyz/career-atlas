import { RefreshCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center py-24 text-center">
      <p className="text-5xl font-semibold text-ink-4">404</p>
      <h1 className="mt-3 text-lg font-semibold">{t("errors.pageNotFound")}</h1>
      <p className="mt-1 text-[13px] text-ink-3">{t("errors.pageNotFoundBody")}</p>
      <Button variant="primary" className="mt-5" asChild>
        <Link to="/">{t("errors.goHome")}</Link>
      </Button>
    </div>
  );
}

export function ErrorBoundary() {
  const { t } = useTranslation();
  const err = useRouteError();
  if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 404) return <NotFound />;
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-6 text-center">
      <h1 className="text-lg font-semibold">{t("errors.boundaryTitle")}</h1>
      <p className="mt-1 text-[13px] text-ink-3">{t("errors.boundaryBody")}</p>
      <Button variant="primary" className="mt-5" onClick={() => window.location.reload()}>
        <RefreshCw />
        {t("errors.reload")}
      </Button>
    </div>
  );
}
