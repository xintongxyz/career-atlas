import { useQuery } from "@tanstack/react-query";
import { Briefcase, Building2, Search } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Dialog as D } from "radix-ui";
import { StatusBadge, displayCompany, displayTitle } from "@/components/jobs/badges";
import { Kbd, Spinner } from "@/components/ui/misc";
import { api, qs } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PipelineStatus } from "@shared/constants";

type Results = { jobs: { id: string; title: string; company_name: string; city: string | null; status: PipelineStatus }[]; companies: { id: string; name: string; job_count: number }[] };

export function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [q, setQ] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [active, setActive] = React.useState(0);
  React.useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(h);
  }, [q]);
  React.useEffect(() => {
    if (!open) {
      setQ("");
      setDebounced("");
    }
  }, [open]);
  const res = useQuery({ queryKey: ["search", debounced], queryFn: () => api.get<Results>(`/api/search${qs({ q: debounced })}`), enabled: debounced.length > 0 });
  const items = [
    ...(res.data?.jobs ?? []).map((j) => ({ key: `j${j.id}`, go: `/jobs/${j.id}`, kind: "job" as const, j })),
    ...(res.data?.companies ?? []).map((c) => ({ key: `c${c.id}`, go: `/positions?company_id=${c.id}`, kind: "company" as const, c })),
  ];
  React.useEffect(() => setActive(0), [debounced]);
  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-ink/25" />
        <D.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-24px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <D.Title className="sr-only">{t("actions.search")}</D.Title>
          <D.Description className="sr-only">{t("search.placeholder")}</D.Description>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 text-ink-4" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("search.placeholder")}
              aria-label={t("search.placeholder")}
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-4"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(items.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter" && items[active]) go(items[active].go);
              }}
            />
            {res.isFetching ? <Spinner /> : <Kbd>Esc</Kbd>}
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
            {!debounced ? <p className="px-3 py-6 text-center text-xs text-ink-4">{t("search.hint")}</p> : null}
            {debounced && res.data && items.length === 0 ? <p className="px-3 py-6 text-center text-xs text-ink-3">{t("search.noResults", { q: debounced })}</p> : null}
            {items.map((it, i) => (
              <button
                key={it.key}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(it.go)}
                className={cn("flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left", i === active && "bg-subtle")}
              >
                {it.kind === "job" ? (
                  <>
                    <Briefcase className="size-4 text-ink-4" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{displayTitle(it.j.title, t)}</span>
                      <span className="block truncate text-xs text-ink-3">
                        {displayCompany(it.j.company_name, t)}
                        {it.j.city ? ` · ${it.j.city}` : ""}
                      </span>
                    </span>
                    <StatusBadge status={it.j.status} />
                  </>
                ) : (
                  <>
                    <Building2 className="size-4 text-ink-4" />
                    <span className="flex-1 truncate text-[13px]">{it.c.name}</span>
                    <span className="text-xs text-ink-4">{t("search.jobsAtCompany", { count: it.c.job_count })}</span>
                  </>
                )}
              </button>
            ))}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
