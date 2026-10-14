import type { DashboardDTO } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Bookmark, UserRound, CalendarDays, FileText, LayoutDashboard, Menu as MenuIcon, Plus, Search, Settings, Table2, Trello, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router";
import { toast } from "sonner";
import { QuickAddDialog } from "@/components/jobs/quick-add";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/misc";
import { useMe } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { cn, isTypingTarget } from "@/lib/utils";
import { LanguageToggle } from "./language-toggle";
import { QuickAddContext } from "./quick-add-context";
import { SaveIndicator } from "./save-indicator";
import { SearchDialog } from "./search-dialog";

const NAV = [
  { to: "/", key: "dashboard", icon: LayoutDashboard, end: true },
  { to: "/saved", key: "saved", icon: Bookmark },
  { to: "/applications", key: "applications", icon: Trello },
  { to: "/positions", key: "positions", icon: Table2 },
  { to: "/calendar", key: "calendar", icon: CalendarDays },
  { to: "/analytics", key: "analytics", icon: BarChart3 },
  { to: "/documents", key: "documents", icon: FileText },
  { to: "/profile", key: "profile", icon: UserRound },
  { to: "/settings", key: "settings", icon: Settings },
] as const;

function useNavCounts() {
  return useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<DashboardDTO>("/api/dashboard"), staleTime: 60_000 });
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const counts = useNavCounts().data?.counts;
  return (
    <nav aria-label={t("nav.menu")} className="flex flex-col gap-0.5">
      {NAV.map(({ to, key, icon: Icon, ...rest }) => {
        // Only show counts that call for action — no vanity badges.
        const badge = key === "dashboard" && counts?.follow_ups_due ? { n: counts.follow_ups_due, label: t("nav.followUpBadge", { count: counts.follow_ups_due }) } : key === "positions" && counts?.needs_review ? { n: counts.needs_review, label: t("nav.reviewBadge", { count: counts.needs_review }) } : null;
        return (
          <NavLink
            key={to}
            to={to}
            end={"end" in rest}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn("group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-muted/60 hover:text-ink", isActive && "bg-surface text-ink shadow-card")
            }
          >
            <Icon className="size-4 text-ink-3 group-aria-[current=page]:text-accent" aria-hidden />
            <span className="flex-1 truncate">{t(`nav.${key}`)}</span>
            {badge ? (
              <span title={badge.label} className="rounded-full bg-warn-soft px-1.5 text-[11px] font-semibold text-warn tabular">
                {badge.n}
                <span className="sr-only">{badge.label}</span>
              </span>
            ) : null}
          </NavLink>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-2.5">
      <img src="/favicon.svg" alt="" className="size-6" />
      <span className="text-[14px] font-semibold tracking-tight">Career Atlas</span>
    </div>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const me = useMe();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [mobileNav, setMobileNav] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [quickAdd, setQuickAdd] = React.useState<{ open: boolean; url?: string; tab?: "url" | "paste" | "manual"; autoSubmit?: boolean }>({ open: false });
  const quickAddCtx = React.useMemo(() => ({ open: (o?: { url?: string; tab?: "url" | "paste" | "manual"; autoSubmit?: boolean }) => setQuickAdd({ open: true, ...o }) }), []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n") {
        e.preventDefault();
        setQuickAdd({ open: true });
      } else if (e.key === "/") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === "?") {
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => setMobileNav(false), [location.pathname]);

  return (
    <QuickAddContext.Provider value={quickAddCtx}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        {t("app.skipToContent")}
      </a>
      {me.data?.config.demo ? <div className="bg-warn-soft px-4 py-1.5 text-center text-xs text-warn">{t("app.demoBanner")}</div> : null}
      {me.data?.config.read_only ? <div role="status" className="bg-info-soft px-4 py-1.5 text-center text-xs text-info">{t("app.readOnlyBanner")}</div> : null}
      <div className="flex min-h-dvh">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col gap-5 border-r border-line bg-canvas px-3 py-4 lg:flex">
          <Brand />
          <NavItems />
          <div className="mt-auto space-y-3 px-1">
            <AuthExpiredNotice />
            <LanguageToggle />
            {me.data ? <p className="truncate px-1 text-[11px] text-ink-4" title={me.data.user.email}>{me.data.user.email}</p> : null}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas/90 px-4 backdrop-blur lg:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t("nav.menu")} onClick={() => setMobileNav(true)}>
              <MenuIcon />
            </Button>
            <div className="lg:hidden">
              <Brand />
            </div>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="ml-auto flex h-8 w-full max-w-sm items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-[13px] text-ink-4 hover:border-line-strong lg:ml-0 max-sm:w-8 max-sm:justify-center max-sm:px-0"
              aria-label={t("actions.search")}
            >
              <Search className="size-4" />
              <span className="flex-1 text-left max-sm:hidden">{t("search.placeholder")}</span>
              <span className="max-sm:hidden">
                <Kbd>⌘K</Kbd>
              </span>
            </button>
            <div className="ml-auto flex items-center gap-2">
              <SaveIndicator />
              <LanguageToggle className="hidden sm:inline-flex lg:hidden" />
              <Button variant="primary" onClick={() => setQuickAdd({ open: true })} title={`${t("actions.addJob")} (N)`}>
                <Plus />
                <span className="max-sm:hidden">{t("actions.addJob")}</span>
              </Button>
            </div>
          </header>

          <main id="main" className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-24 pt-5 lg:px-6 lg:pb-10">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Mobile navigation drawer */}
      {mobileNav ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t("nav.menu")}>
          <div className="absolute inset-0 bg-ink/25" onClick={() => setMobileNav(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-5 bg-canvas px-3 py-4 shadow-pop">
            <div className="flex items-center justify-between">
              <Brand />
              <Button variant="ghost" size="icon" aria-label={t("actions.close")} onClick={() => setMobileNav(false)}>
                <X />
              </Button>
            </div>
            <NavItems onNavigate={() => setMobileNav(false)} />
            <div className="mt-auto px-1">
              <LanguageToggle />
            </div>
          </div>
        </div>
      ) : null}

      {/* Mobile bottom bar */}
      <nav aria-label={t("nav.more")} className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {[NAV[0], NAV[1], null, NAV[2], NAV[3]].map((n, i) =>
          n ? (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => cn("flex flex-col items-center gap-0.5 py-2 text-[10px] text-ink-3", isActive && "text-accent")}>
              <n.icon className="size-5" aria-hidden />
              <span className="max-w-full truncate px-1">{t(`nav.${n.key}`)}</span>
            </NavLink>
          ) : (
            <button key={`add${i}`} type="button" onClick={() => setQuickAdd({ open: true })} className="flex items-center justify-center" aria-label={t("actions.addJob")}>
              <span className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-ink shadow-pop">
                <Plus className="size-5" />
              </span>
            </button>
          ),
        )}
      </nav>

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <QuickAddDialog open={quickAdd.open} initialUrl={quickAdd.url} initialTab={quickAdd.tab} autoSubmit={quickAdd.autoSubmit} onOpenChange={(o) => setQuickAdd((s) => ({ ...s, open: o, url: o ? s.url : undefined, autoSubmit: o ? s.autoSubmit : false }))} />
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent title={t("shortcuts.title")} size="sm">
          <ShortcutList />
        </DialogContent>
      </Dialog>
    </QuickAddContext.Provider>
  );
}

export function ShortcutList() {
  const { t } = useTranslation();
  const rows: [string, string][] = [
    ["⌘/Ctrl K", t("shortcuts.search")],
    ["/", t("shortcuts.search")],
    ["N", t("shortcuts.addJob")],
    ["⌘/Ctrl S", t("shortcuts.save")],
    ["?", t("shortcuts.help")],
  ];
  return (
    <dl className="divide-y divide-line">
      {rows.map(([k, v]) => (
        <div key={k + v} className="flex items-center justify-between py-2 text-[13px]">
          <dt className="text-ink-2">{v}</dt>
          <dd>
            <Kbd>{k}</Kbd>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function AuthExpiredNotice() {
  const { t } = useTranslation();
  React.useEffect(() => {
    const onExpired = () => toast.error(t("errors.unauthenticated"), { duration: Infinity, action: { label: t("errors.reload"), onClick: () => window.location.reload() } });
    window.addEventListener("career-atlas:auth-expired", onExpired);
    return () => window.removeEventListener("career-atlas:auth-expired", onExpired);
  }, [t]);
  return null;
}
