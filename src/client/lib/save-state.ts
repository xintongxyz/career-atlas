// Global "Saving… / Saved / Failed to save" state and unsaved-change protection.
//
// Every write goes through a TanStack mutation, so the mutation cache is the source of truth for
// in-flight saves. Text fields that autosave after a pause register themselves as "dirty" while
// the user is typing, so closing the tab in that window asks for confirmation.
import type { QueryClient } from "@tanstack/react-query";
import * as React from "react";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

let status: SaveStatus = "idle";
let pending = 0;
const dirty = new Set<string>(); // autosave fields waiting for their debounce → shown as "Saving…"
const drafts = new Set<string>(); // explicit-submit drafts (new note, open edit form) → close-tab warning only
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function recompute(next?: SaveStatus) {
  const s: SaveStatus = pending > 0 || dirty.size > 0 ? "saving" : (next ?? status);
  if (s !== status) {
    status = s;
    emit();
  }
}

/** Marks a draft as having unsaved changes (or clears it). */
export function setDirty(key: string, isDirty: boolean) {
  const had = dirty.has(key);
  if (isDirty) dirty.add(key);
  else dirty.delete(key);
  if (had !== isDirty) recompute(isDirty ? undefined : status === "saving" && pending === 0 ? "saved" : undefined);
}

/** Registers an explicit-submit draft (e.g. an unsent note) so closing the tab asks first. */
export function markUnsentDraft(key: string, hasDraft: boolean) {
  if (hasDraft) drafts.add(key);
  else drafts.delete(key);
}

export function hasUnsavedChanges() {
  return pending > 0 || dirty.size > 0 || drafts.size > 0;
}

/** Wires the indicator to the query client's mutation cache. Call once at startup. */
export function trackMutations(client: QueryClient) {
  client.getMutationCache().subscribe((e) => {
    if (e.type !== "updated" || e.mutation.meta?.notASave) return;
    const state = e.mutation.state.status;
    if (e.action.type === "pending") {
      pending++;
      recompute();
    } else if (e.action.type === "success" || e.action.type === "error") {
      pending = Math.max(0, pending - 1);
      recompute(state === "error" ? "error" : "saved");
    }
  });
  window.addEventListener("beforeunload", (ev) => {
    if (!hasUnsavedChanges()) return;
    ev.preventDefault();
    ev.returnValue = ""; // older browsers need a value to show the prompt
  });
}

export function useSaveStatus(): SaveStatus {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
    () => "idle",
  );
}

/**
 * Debounced autosave for a free-text field: saves `delay` ms after the user stops typing,
 * immediately on blur, and on unmount if a change is still pending.
 */
export function useAutosaveText(key: string, saved: string, save: (v: string) => void, delay = 900) {
  const [value, setValue] = React.useState(saved);
  const latest = React.useRef({ value, saved, save });
  latest.current = { value, saved, save };
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt server value when it changes and the user has nothing pending.
  React.useEffect(() => {
    if (!timer.current) setValue(saved);
  }, [saved]);

  const flush = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { value: v, saved: s, save: fn } = latest.current;
    if (v !== s) fn(v);
    setDirty(key, false);
  }, [key]);

  const onChange = React.useCallback(
    (v: string) => {
      setValue(v);
      setDirty(key, v !== latest.current.saved);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delay);
    },
    [delay, flush, key],
  );

  React.useEffect(() => () => {
    if (timer.current) flush();
  }, [flush]);

  return { value, onChange, onBlur: flush };
}
