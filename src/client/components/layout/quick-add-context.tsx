import * as React from "react";

type Ctx = { open: (opts?: { url?: string; tab?: "url" | "paste" | "manual"; autoSubmit?: boolean }) => void };
export const QuickAddContext = React.createContext<Ctx>({ open: () => undefined });
export const useQuickAdd = () => React.useContext(QuickAddContext);
