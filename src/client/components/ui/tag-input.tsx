import { X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** Chip input for tags / short lists. Enter or comma adds; Backspace removes the last. */
export function TagInput({ value, onChange, placeholder, suggestions = [], id, className, max = 30 }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[]; id?: string; className?: string; max?: number }) {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState("");
  const listId = React.useId();
  const add = (raw: string) => {
    const v = raw.trim().replace(/,$/, "");
    if (!v || value.some((x) => x.toLowerCase() === v.toLowerCase()) || value.length >= max) return setDraft("");
    onChange([...value, v]);
    setDraft("");
  };
  return (
    <div className={cn("flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15", className)}>
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-0.5 rounded bg-subtle py-0.5 pl-1.5 pr-0.5 text-xs text-ink-2">
          {tag}
          <button type="button" aria-label={`${t("actions.delete")} ${tag}`} className="rounded p-0.5 text-ink-4 hover:bg-muted hover:text-ink" onClick={() => onChange(value.filter((x) => x !== tag))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        list={suggestions.length ? listId : undefined}
        value={draft}
        placeholder={value.length ? undefined : placeholder}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft && add(draft)}
        className="min-w-24 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-ink-4"
      />
      {suggestions.length ? (
        <datalist id={listId}>
          {suggestions.filter((s) => !value.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}
