import type { JobListItem } from "@shared/types";
import { BellRing, CalendarX2, MapPin } from "lucide-react";
import * as React from "react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/misc";
import { useLocaleContext } from "@/hooks/useMe";
import { formatRelative, formatShortDate, locationText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CompanyAvatar, ExtractionBadge, PriorityBadge, SalaryText, StarMark, WorkModeBadge, displayCompany, displayTitle } from "./badges";

/** Compact job card used on the board and saved list. */
export const JobCard = React.forwardRef<HTMLDivElement, { job: JobListItem; dragging?: boolean; showStatus?: React.ReactNode; actions?: React.ReactNode; linkable?: boolean } & React.HTMLAttributes<HTMLDivElement>>(
  ({ job, dragging, showStatus, actions, linkable = true, className, ...props }, ref) => {
    const { t, lang, tz } = useLocaleContext();
    const loc = locationText(job);
    const soon = job.deadline_at && job.deadline_at > Date.now() && job.deadline_at - Date.now() < 7 * 86_400_000;
    const followDue = job.follow_up_at && job.follow_up_at <= Date.now() + 86_400_000;
    const title = displayTitle(job.title, t);
    return (
      <div ref={ref} className={cn("group rounded-lg border border-line bg-surface p-3 shadow-card transition-shadow", dragging && "rotate-1 shadow-pop ring-2 ring-accent/30", className)} {...props}>
        <div className="flex items-start gap-2.5">
          <CompanyAvatar name={job.company_name} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <p className="truncate text-xs text-ink-3">{displayCompany(job.company_name, t)}</p>
              <StarMark starred={job.is_starred} />
            </div>
            {linkable ? (
              <Link to={`/jobs/${job.id}`} className="line-clamp-2 text-[13px] font-medium leading-snug text-ink hover:underline" onPointerDown={(e) => e.stopPropagation()}>
                {title}
              </Link>
            ) : (
              <p className="line-clamp-2 text-[13px] font-medium leading-snug">{title}</p>
            )}
          </div>
          {actions}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          {showStatus}
          {loc ? (
            <span className="inline-flex max-w-full items-center gap-0.5 truncate">
              <MapPin className="size-3 shrink-0" />
              {loc}
            </span>
          ) : null}
          <WorkModeBadge mode={job.work_mode} />
          <ExtractionBadge status={job.extraction_status} />
        </div>
        {job.salary ? <SalaryText salary={job.salary} className="mt-1.5 block text-xs text-ink-2" /> : null}
        {job.tags.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {job.tags.slice(0, 4).map((tg) => (
              <Badge key={tg.id} tone="neutral">
                {tg.name}
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-2 border-t border-line/70 pt-2 text-[11px] text-ink-4">
          <PriorityBadge priority={job.priority} />
          {soon ? (
            <span className="inline-flex items-center gap-0.5 text-warn">
              <CalendarX2 className="size-3" />
              {t("saved.deadlineIn", { when: formatShortDate(job.deadline_at, lang, tz) })}
            </span>
          ) : null}
          {followDue ? (
            <span className="inline-flex items-center gap-0.5 text-warn">
              <BellRing className="size-3" />
              {formatShortDate(job.follow_up_at, lang, tz)}
            </span>
          ) : null}
          {job.next_action ? <span className="truncate" title={job.next_action}>→ {job.next_action}</span> : null}
          <span className="ml-auto shrink-0" title={t("fields.last_activity_at")}>
            {formatRelative(job.last_activity_at, lang)}
          </span>
        </div>
      </div>
    );
  },
);
JobCard.displayName = "JobCard";
