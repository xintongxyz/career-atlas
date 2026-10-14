import type { DraftDTO } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Sparkles } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { ExtractionReview } from "@/components/jobs/extraction-review";
import { Badge, Card, Checkbox } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { NotFound, PageFallback, PageHeader } from "./system";

/** Review an AI draft (Claude Desktop extension or Import from AI). Nothing is stored until Save. */
export default function DraftPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [confirmDup, setConfirmDup] = React.useState(false);
  const q = useQuery({ queryKey: ["draft", id], queryFn: () => api.get<DraftDTO>(`/api/drafts/${id}`), retry: false });
  if (q.isPending) return <PageFallback />;
  if (q.isError || !q.data) return <NotFound />;
  const d = q.data;
  if (d.status !== "pending") {
    return (
      <div className="max-w-3xl">
        <PageHeader title={t("drafts.title")} />
        <Card className="p-4 text-[13px]">
          {d.status === "saved" && d.saved_job_id ? (
            <Link to={`/jobs/${d.saved_job_id}`} className="text-accent underline">
              {t("drafts.alreadySaved")}
            </Link>
          ) : (
            t("drafts.discardedNote")
          )}
        </Card>
      </div>
    );
  }
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader title={t("drafts.title")} subtitle={t("drafts.subtitle")} />
      <Card className="space-y-2 p-4 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="violet">
            <Sparkles />
            {t(`drafts.origin.${d.origin}`)}
          </Badge>
          {d.source_url ? (
            <a href={d.source_url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-w-0 items-center gap-1 truncate text-accent underline">
              <ExternalLink className="size-3.5 shrink-0" />
              <span className="truncate">{d.source_url}</span>
            </a>
          ) : null}
        </div>
        <p className="text-xs text-ink-3">{t("drafts.legend")}</p>
        {d.notes ? (
          <p className="rounded-md bg-subtle px-3 py-2 text-xs text-ink-2">
            <span className="font-medium">{t("drafts.aiNotes")}: </span>
            {d.notes}
          </p>
        ) : null}
        {d.url_duplicates.length ? (
          <div className="space-y-1.5 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
            <p className="flex flex-wrap items-center gap-2">
              <AlertTriangle className="size-4" />
              {t("drafts.duplicateUrl")}
              {d.url_duplicates.slice(0, 3).map((m) => (
                <Link key={m.id} to={`/jobs/${m.id}`} className="font-medium underline">
                  {m.company_name} — {m.title}
                </Link>
              ))}
            </p>
            <label className="flex items-center gap-2">
              <Checkbox checked={confirmDup} onCheckedChange={(v) => setConfirmDup(!!v)} />
              {t("drafts.saveAnyway")}
            </label>
          </div>
        ) : null}
      </Card>
      <Card className="p-4">
        <ExtractionReview
          extraction={d.extraction}
          endpoints={{ apply: `/api/drafts/${d.id}/save`, dismiss: `/api/drafts/${d.id}/discard` }}
          applyExtra={{ confirm_duplicate: confirmDup }}
          onApplied={(jobId) => navigate(`/jobs/${jobId}`)}
          onDismiss={() => navigate("/")}
        />
      </Card>
    </div>
  );
}
