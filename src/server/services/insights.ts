import { PIPELINE_STATUSES, RESPONSE_STATUSES, TERMINAL_APPLICATION_STATUSES, type ApplicationStatus, type PipelineStatus } from "@shared/constants";
import type { AnalyticsDTO, DashboardDTO, Ratio } from "@shared/types";
import type { Db } from "../db/client";
import { EFFECTIVE_STATUS_SQL } from "../repositories/jobs-repo";
import { calendarItems, listEvents } from "./activity";

const DAY = 86_400_000;

/** Calendar parts of a timestamp in a given IANA time zone. */
export function zonedParts(t: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

/** UTC timestamp of the end of the local day containing `t` in `timeZone`. */
export function endOfLocalDay(t: number, timeZone: string): number {
  const p = zonedParts(t, timeZone);
  const elapsed = (p.h * 60 + p.min) * 60_000 + (t % 60_000);
  return t - elapsed + DAY - 1;
}

export async function getDashboard(db: Db, userId: string, timeZone: string): Promise<DashboardDTO> {
  const d1 = db.$client;
  const nowTs = Date.now();
  const endToday = endOfLocalDay(nowTs, timeZone);
  const [statusRows, counts, followUps, review] = await Promise.all([
    d1
      .prepare(
        `SELECT ${EFFECTIVE_STATUS_SQL} AS status, COUNT(*) AS n FROM saved_jobs sj
         JOIN job_postings p ON p.id = sj.job_posting_id AND p.deleted_at IS NULL
         LEFT JOIN applications a ON a.saved_job_id = sj.id WHERE sj.user_id = ? GROUP BY 1`,
      )
      .bind(userId)
      .all<{ status: PipelineStatus; n: number }>(),
    d1
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM saved_jobs sj JOIN job_postings p ON p.id = sj.job_posting_id AND p.deleted_at IS NULL WHERE sj.user_id = ?1 AND sj.archived_at IS NULL) AS saved_total,
           (SELECT COUNT(*) FROM applications a JOIN job_postings p ON p.id = a.job_posting_id AND p.deleted_at IS NULL WHERE a.user_id = ?1) AS applications_total`,
      )
      .bind(userId)
      .first<{ saved_total: number; applications_total: number }>(),
    d1
      .prepare(`SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND kind = 'follow_up' AND completed_at IS NULL AND deleted_at IS NULL AND due_at <= ?`)
      .bind(userId, endToday)
      .first<{ n: number }>(),
    d1
      .prepare(
        `SELECT COUNT(DISTINCT p.id) AS n FROM job_postings p JOIN saved_jobs sj ON sj.job_posting_id = p.id
         LEFT JOIN job_extraction_jobs x ON x.id = p.latest_extraction_id
         WHERE p.user_id = ? AND p.deleted_at IS NULL AND sj.archived_at IS NULL AND (
           EXISTS (SELECT 1 FROM extracted_field_evidence e WHERE e.job_posting_id = p.id AND e.review_status = 'needs_review')
           OR (x.status IN ('succeeded','partial','needs_review') AND x.applied_at IS NULL AND x.dismissed_at IS NULL))`,
      )
      .bind(userId)
      .first<{ n: number }>(),
  ]);
  const byStatus = new Map(statusRows.results.map((r) => [r.status, r.n]));
  const n = (...s: PipelineStatus[]) => s.reduce((acc, k) => acc + (byStatus.get(k) ?? 0), 0);

  const [recent, upcomingAll] = await Promise.all([listEvents(db, userId, { limit: 12 }), calendarItems(db, userId, nowTs - 60 * DAY, nowTs + 14 * DAY)]);
  const upcoming = upcomingAll.filter((i) => i.at >= nowTs && !i.completed && i.kind !== "applied").slice(0, 20);
  const overdue = upcomingAll.filter((i) => i.at < nowTs && i.reminder_id && !i.completed).slice(0, 20);

  return {
    counts: {
      saved_total: counts?.saved_total ?? 0,
      applications_total: counts?.applications_total ?? 0,
      awaiting_response: n("applied", "awaiting_response"),
      interviews: n("interview"),
      offers: n("offer", "accepted"),
      follow_ups_due: followUps?.n ?? 0,
      needs_review: review?.n ?? 0,
    },
    pipeline: PIPELINE_STATUSES.map((status) => ({ status, count: byStatus.get(status) ?? 0 })),
    recent_events: recent,
    upcoming,
    overdue,
  };
}

// ---------------------------------------------------------------- analytics

function stats(values: number[]) {
  if (!values.length) return { count: 0, average: null, median: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  return { count: values.length, average: Math.round(average * 10) / 10, median: Math.round(median * 10) / 10 };
}

const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator, value: denominator > 0 ? numerator / denominator : null });

function isoWeekKey(t: number, tz: string) {
  const p = zonedParts(t, tz);
  const date = new Date(Date.UTC(p.y, p.m - 1, p.d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
const monthKey = (t: number, tz: string) => {
  const p = zonedParts(t, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}`;
};

interface AppRow {
  id: string;
  status: ApplicationStatus;
  applied_at: number;
  first_response_at: number | null;
  reached_assessment_at: number | null;
  reached_interview_at: number | null;
  reached_offer_at: number | null;
  final_outcome_at: number | null;
  category: string | null;
  work_mode: string;
  city: string | null;
  source_platform: string;
  resume_name: string | null;
}

/**
 * Cohort analytics: applications are included by their applied_at date.
 * "Effective applications" exclude applications the user withdrew before any
 * employer response (they never had a chance to convert).
 * Conversion uses milestone timestamps (first time a stage was reached), so an
 * application that reached Interview and was later rejected still counts as
 * an interview.
 */
export async function getAnalytics(db: Db, userId: string, range: { from?: number; to?: number }, tz: string): Promise<AnalyticsDTO> {
  const d1 = db.$client;
  const from = range.from ?? 0;
  const to = range.to ?? 8_640_000_000_000_000;
  const [apps, saved, events, overdue] = await Promise.all([
    d1
      .prepare(
        `SELECT a.id, a.status, a.applied_at, a.first_response_at, a.reached_assessment_at, a.reached_interview_at, a.reached_offer_at,
                a.final_outcome_at, p.category, p.work_mode, p.city, p.source_platform, d.version_name AS resume_name
         FROM applications a JOIN job_postings p ON p.id = a.job_posting_id AND p.deleted_at IS NULL
         LEFT JOIN documents d ON d.id = a.resume_document_id
         WHERE a.user_id = ? AND a.applied_at BETWEEN ? AND ?`,
      )
      .bind(userId, from, to)
      .all<AppRow>(),
    d1
      .prepare(`SELECT sj.saved_at FROM saved_jobs sj JOIN job_postings p ON p.id = sj.job_posting_id AND p.deleted_at IS NULL WHERE sj.user_id = ? AND sj.saved_at BETWEEN ? AND ?`)
      .bind(userId, from, to)
      .all<{ saved_at: number }>(),
    d1
      .prepare(
        `SELECT e.application_id, e.to_status, e.occurred_at FROM application_events e
         JOIN applications a ON a.id = e.application_id
         WHERE e.user_id = ? AND e.deleted_at IS NULL AND e.type IN ('application_submitted','status_changed') AND a.applied_at BETWEEN ? AND ?
         ORDER BY e.application_id, e.occurred_at, e.created_at`,
      )
      .bind(userId, from, to)
      .all<{ application_id: string; to_status: string; occurred_at: number }>(),
    d1
      .prepare(`SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND kind = 'follow_up' AND completed_at IS NULL AND deleted_at IS NULL AND due_at < ?`)
      .bind(userId, Date.now())
      .first<{ n: number }>(),
  ]);
  const rows = apps.results;
  const withdrawnNoResponse = rows.filter((a) => a.status === "withdrawn" && a.first_response_at == null).length;
  const effective = rows.length - withdrawnNoResponse;
  const responses = rows.filter((a) => a.first_response_at != null || RESPONSE_STATUSES.includes(a.status)).length;
  const interviews = rows.filter((a) => a.reached_interview_at != null).length;
  const offers = rows.filter((a) => a.reached_offer_at != null).length;
  const interviewThenOffer = rows.filter((a) => a.reached_interview_at != null && a.reached_offer_at != null).length;

  const byStatus = new Map<string, number>();
  for (const a of rows) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);

  const bucket = (keyFn: (t: number) => string) => {
    const m = new Map<string, { applied: number; saved: number }>();
    for (const a of rows) {
      const k = keyFn(a.applied_at);
      const v = m.get(k) ?? { applied: 0, saved: 0 };
      v.applied++;
      m.set(k, v);
    }
    for (const s of saved.results) {
      const k = keyFn(s.saved_at);
      const v = m.get(k) ?? { applied: 0, saved: 0 };
      v.saved++;
      m.set(k, v);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, v]) => ({ period, ...v }));
  };

  // Time spent in each completed stage, derived from the append-only event log.
  const stageDurations = new Map<string, number[]>();
  let prev: { app: string; status: string; at: number } | null = null;
  for (const e of events.results) {
    if (prev && prev.app === e.application_id && e.to_status && e.to_status !== prev.status) {
      const list = stageDurations.get(prev.status) ?? [];
      list.push((e.occurred_at - prev.at) / DAY);
      stageDurations.set(prev.status, list);
    }
    if (!prev || prev.app !== e.application_id || (e.to_status && e.to_status !== prev.status)) {
      prev = { app: e.application_id, status: e.to_status ?? "applied", at: e.occurred_at };
    }
  }

  const segment = (keyFn: (a: AppRow) => string | null) => {
    const m = new Map<string, { applied: number; responses: number; interviews: number; offers: number }>();
    for (const a of rows) {
      const k = keyFn(a)?.trim() || "unknown";
      const v = m.get(k) ?? { applied: 0, responses: 0, interviews: 0, offers: 0 };
      v.applied++;
      if (a.first_response_at != null) v.responses++;
      if (a.reached_interview_at != null) v.interviews++;
      if (a.reached_offer_at != null) v.offers++;
      m.set(k, v);
    }
    return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.applied - a.applied).slice(0, 15);
  };

  const nowTs = Date.now();
  const open = rows.filter((a) => !TERMINAL_APPLICATION_STATUSES.includes(a.status));
  return {
    range: { from: range.from ?? null, to: range.to ?? null },
    totals: {
      saved: saved.results.length,
      applied: rows.length,
      responses,
      assessments: rows.filter((a) => a.reached_assessment_at != null).length,
      interviews,
      offers,
      rejections: byStatus.get("rejected") ?? 0,
      withdrawals: byStatus.get("withdrawn") ?? 0,
      active: open.length,
    },
    by_status: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
    by_week: bucket((t) => isoWeekKey(t, tz)),
    by_month: bucket((t) => monthKey(t, tz)),
    rates: {
      response_rate: ratio(responses, effective),
      interview_rate: ratio(interviews, effective),
      offer_rate: ratio(offers, effective),
      interview_to_offer: ratio(interviewThenOffer, interviews),
    },
    time: {
      first_response_days: stats(rows.filter((a) => a.first_response_at != null).map((a) => Math.max(0, (a.first_response_at! - a.applied_at) / DAY))),
      stage_days: [...stageDurations.entries()].map(([status, v]) => ({ status, ...stats(v) })),
      open_applications_age_days: (() => {
        const s = stats(open.map((a) => (nowTs - a.applied_at) / DAY));
        return { count: s.count, median: s.median };
      })(),
      overdue_follow_ups: overdue?.n ?? 0,
    },
    segments: {
      category: segment((a) => a.category),
      resume: segment((a) => a.resume_name),
      work_mode: segment((a) => a.work_mode),
      city: segment((a) => a.city),
      source: segment((a) => a.source_platform),
      month: segment((a) => monthKey(a.applied_at, tz)),
    },
  };
}
