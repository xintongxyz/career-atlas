import type { DraftSummaryDTO } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useLocaleContext } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";

/** Dashboard box: AI drafts waiting for review. Hidden when there are none. */
export function DraftsInbox() {
  const { t } = useTranslation();
  const { lang } = useLocaleContext();
  const q = useQuery({ queryKey: ["drafts"], queryFn: () => api.get<{ items: DraftSummaryDTO[] }>("/api/drafts"), refetchInterval: 15_000 });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section aria-label={t("drafts.inbox")} className="rounded-lg border border-violet/30 bg-violet-soft/40 px-4 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-ink">
        <Sparkles className="size-4 text-violet" aria-hidden />
        {t("drafts.waiting", { count: items.length })}
      </p>
      <ul className="space-y-1">
        {items.slice(0, 5).map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 text-[13px]">
            <Link to={`/drafts/${d.id}`} className="min-w-0 truncate text-accent underline">
              {d.company_name ?? t("drafts.unknownCompany")} — {d.title ?? t("drafts.untitled")}
            </Link>
            <span className="shrink-0 text-xs text-ink-4">{formatRelative(d.created_at, lang)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
