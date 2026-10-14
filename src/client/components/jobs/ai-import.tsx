import { aiImportPrompt, parseAiReply } from "@shared/ai-import-prompt";
import type { DraftCreatedDTO } from "@shared/types";
import { useMutation } from "@tanstack/react-query";
import { ClipboardCopy } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/input";
import { useToastError } from "@/hooks/useApiError";
import { api } from "@/lib/api";

export function AiImportForm({ onCreated }: { onCreated: (draftId: string) => void }) {
  const { t } = useTranslation();
  const onError = useToastError();
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<DraftCreatedDTO>("/api/drafts", { ...body, origin: "paste" }),
    onSuccess: (r) => onCreated(r.id),
    onError,
  });
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(aiImportPrompt());
      toast.success(t("drafts.import.promptCopied"));
    } catch {
      toast.error(t("drafts.import.copyFailed"));
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseAiReply(text);
        if (!parsed) return setError(t("drafts.import.unreadable"));
        setError(null);
        create.mutate(parsed);
      }}
    >
      <p className="text-[13px] text-ink-3">{t("drafts.import.intro")}</p>
      <Button type="button" variant="secondary" onClick={copyPrompt}>
        <ClipboardCopy />
        {t("drafts.import.copyPrompt")}
      </Button>
      <Field label={t("drafts.import.label")} htmlFor="ai-import" error={error ?? undefined} hint={t("drafts.import.hint")}>
        <Textarea id="ai-import" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("drafts.import.placeholder")} className="font-mono text-xs" />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!text.trim() || create.isPending}>
          {create.isPending ? t("actions.saving") : t("drafts.import.createDraft")}
        </Button>
      </div>
    </form>
  );
}
