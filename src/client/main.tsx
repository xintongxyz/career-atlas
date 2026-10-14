import "./index.css";
import "./i18n";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/app-shell";
import { TooltipProvider } from "@/components/ui/overlay";
import { ApiRequestError } from "@/lib/api";
import { trackMutations } from "@/lib/save-state";
import { ErrorBoundary, NotFound, PageFallback } from "@/pages/system";

const lazy = (load: () => Promise<{ default: React.ComponentType }>) => {
  const C = React.lazy(load);
  return (
    <React.Suspense fallback={<PageFallback />}>
      <C />
    </React.Suspense>
  );
};

let authNotified = false;
function onAuthError(err: unknown) {
  // Identity problems: ask the user to reload instead of failing silently.
  if (err instanceof ApiRequestError && err.code === "unauthenticated" && !authNotified) {
    authNotified = true;
    window.dispatchEvent(new CustomEvent("career-atlas:auth-expired"));
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

// Saving / Saved / Failed indicator + a warning before closing the tab with unsaved changes.
trackMutations(queryClient);

const router = createBrowserRouter([
  {
    element: <AppShell />,
    errorElement: <ErrorBoundary />,
    children: [
      { index: true, element: lazy(() => import("@/pages/dashboard")) },
      { path: "saved", element: lazy(() => import("@/pages/saved")) },
      { path: "applications", element: lazy(() => import("@/pages/applications")) },
      { path: "positions", element: lazy(() => import("@/pages/positions")) },
      { path: "jobs/:id", element: lazy(() => import("@/pages/job-detail")) },
      { path: "compare", element: lazy(() => import("@/pages/compare")) },
      { path: "calendar", element: lazy(() => import("@/pages/calendar")) },
      { path: "analytics", element: lazy(() => import("@/pages/analytics")) },
      { path: "documents", element: lazy(() => import("@/pages/documents")) },
      { path: "settings", element: lazy(() => import("@/pages/settings")) },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: "text-[13px]" }} />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
