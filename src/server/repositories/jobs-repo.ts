import type { JobListQuery, Salary } from "@shared/schemas";
import type { JobListItem, TagDTO } from "@shared/types";
import { escapeLike } from "../lib/util";

/** SQL for the unified pipeline status (see shared/constants PIPELINE_STATUSES). */
export const EFFECTIVE_STATUS_SQL = `CASE WHEN sj.archived_at IS NOT NULL THEN 'archived' WHEN a.id IS NOT NULL THEN a.status ELSE sj.stage END`;

const BASE_SELECT = `
  SELECT
    sj.id AS id, sj.job_posting_id, p.company_id, c.name AS company_name, c.domain AS company_domain,
    c.logo_url AS company_logo_url, p.title, p.city, p.region, p.country, p.work_mode, p.employment_type,
    p.source_platform, p.salary_min, p.salary_max, p.salary_currency, p.salary_period, p.salary_source,
    p.salary_text, p.compensation_type, p.deadline_at, p.posting_status, p.extraction_status,
    sj.stage, a.id AS application_id, a.status AS application_status, sj.priority, sj.is_starred,
    sj.interest_level, sj.next_action, sj.follow_up_at, sj.saved_at, a.applied_at,
    MAX(sj.last_activity_at, COALESCE(a.last_activity_at, 0)) AS last_activity_at, sj.archived_at,
    sj.updated_at,
    (SELECT COUNT(*) FROM extracted_field_evidence e
       WHERE e.job_posting_id = p.id AND e.review_status = 'needs_review') AS needs_review_count,
    EXISTS (SELECT 1 FROM job_extraction_jobs x WHERE x.id = p.latest_extraction_id
       AND x.status IN ('succeeded','partial','needs_review') AND x.applied_at IS NULL AND x.dismissed_at IS NULL) AS pending_extraction,
    ${EFFECTIVE_STATUS_SQL} AS status
  FROM saved_jobs sj
  JOIN job_postings p ON p.id = sj.job_posting_id AND p.deleted_at IS NULL
  JOIN companies c ON c.id = p.company_id
  LEFT JOIN applications a ON a.saved_job_id = sj.id`;

interface Built {
  where: string[];
  params: unknown[];
}

function buildPostingFilters(userId: string, q: Partial<JobListQuery>, includeSalary: boolean): Built {
  const where = ["sj.user_id = ?"];
  const params: unknown[] = [userId];
  const like = (v: string) => `%${escapeLike(v)}%`;

  if (q.q) {
    where.push(
      `(p.title LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR p.city LIKE ? ESCAPE '\\' OR p.category LIKE ? ESCAPE '\\')`,
    );
    params.push(like(q.q), like(q.q), like(q.q), like(q.q));
  }
  const inList = (col: string, values?: string[]) => {
    if (!values?.length) return;
    where.push(`${col} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  inList("p.work_mode", q.work_mode);
  inList("p.employment_type", q.employment_type);
  inList("p.source_platform", q.source);
  if (q.priority?.length) {
    const vals = q.priority.filter((p) => p !== "none");
    const parts: string[] = [];
    if (vals.length) {
      parts.push(`sj.priority IN (${vals.map(() => "?").join(",")})`);
      params.push(...vals);
    }
    if (q.priority.includes("none")) parts.push("sj.priority IS NULL");
    where.push(`(${parts.join(" OR ")})`);
  }
  if (q.company_id) {
    where.push("p.company_id = ?");
    params.push(q.company_id);
  }
  if (q.location) {
    where.push(
      `(p.city LIKE ? ESCAPE '\\' OR p.region LIKE ? ESCAPE '\\' OR p.country LIKE ? ESCAPE '\\' OR p.additional_locations LIKE ? ESCAPE '\\' OR p.remote_eligible_regions LIKE ? ESCAPE '\\')`,
    );
    const v = like(q.location);
    params.push(v, v, v, v, v);
  }
  if (q.skill) {
    where.push(
      `(p.technical_skills LIKE ? ESCAPE '\\' OR p.tools LIKE ? ESCAPE '\\' OR p.required_qualifications LIKE ? ESCAPE '\\' OR p.preferred_qualifications LIKE ? ESCAPE '\\')`,
    );
    const v = like(q.skill);
    params.push(v, v, v, v);
  }
  switch (q.restriction) {
    case "work_authorization":
      where.push("p.work_authorization IS NOT NULL");
      break;
    case "visa_not_available":
      where.push("p.visa_sponsorship = 'not_available'");
      break;
    case "citizenship":
      where.push("(p.citizenship_restriction IS NOT NULL OR p.residency_restriction IS NOT NULL)");
      break;
    case "security_clearance":
      where.push("p.security_clearance IS NOT NULL");
      break;
    case "any":
      where.push(
        "(p.work_authorization IS NOT NULL OR p.visa_sponsorship = 'not_available' OR p.citizenship_restriction IS NOT NULL OR p.residency_restriction IS NOT NULL OR p.security_clearance IS NOT NULL OR p.location_restriction IS NOT NULL)",
      );
      break;
    case "none_known":
      where.push(
        "(p.work_authorization IS NULL AND p.visa_sponsorship <> 'not_available' AND p.citizenship_restriction IS NULL AND p.residency_restriction IS NULL AND p.security_clearance IS NULL AND p.location_restriction IS NULL)",
      );
      break;
  }
  if (q.tag?.length) {
    where.push(
      `EXISTS (SELECT 1 FROM job_tags jt JOIN tags t ON t.id = jt.tag_id WHERE jt.saved_job_id = sj.id AND t.normalized_name IN (${q.tag.map(() => "?").join(",")}))`,
    );
    params.push(...q.tag.map((t) => t.toLowerCase()));
  }
  if (q.starred === "true") where.push("sj.is_starred = 1");
  if (q.archived === "exclude" || !q.archived) where.push("sj.archived_at IS NULL");
  if (q.archived === "only") where.push("sj.archived_at IS NOT NULL");
  if (q.scope === "pre_application") where.push("a.id IS NULL");
  if (q.scope === "applications") where.push("a.id IS NOT NULL");
  if (q.saved_from != null) {
    where.push("sj.saved_at >= ?");
    params.push(q.saved_from);
  }
  if (q.saved_to != null) {
    where.push("sj.saved_at <= ?");
    params.push(q.saved_to);
  }
  if (q.applied_from != null) {
    where.push("a.applied_at >= ?");
    params.push(q.applied_from);
  }
  if (q.applied_to != null) {
    where.push("a.applied_at <= ?");
    params.push(q.applied_to);
  }
  if (includeSalary && q.salary_min != null) {
    // Only compare like with like: same currency and pay period, employer- or
    // user-provided values. Unknown / not comparable rows are excluded and
    // reported separately so the UI can say so.
    where.push("p.salary_currency = ? AND p.salary_period = ? AND COALESCE(p.salary_max, p.salary_min) >= ?");
    params.push(q.salary_currency ?? "CAD", q.salary_period ?? "annually", q.salary_min);
  }
  return { where, params };
}

function outerFilters(q: Partial<JobListQuery>): Built {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status?.length) {
    where.push(`status IN (${q.status.map(() => "?").join(",")})`);
    params.push(...q.status);
  }
  if (q.needs_review === "true") where.push("(needs_review_count > 0 OR pending_extraction = 1)");
  if (q.needs_review === "false") where.push("(needs_review_count = 0 AND pending_extraction = 0)");
  return { where, params };
}

const SORTS: Record<JobListQuery["sort"], string> = {
  saved_at: "saved_at",
  applied_at: "applied_at IS NULL, applied_at",
  updated_at: "updated_at",
  last_activity_at: "last_activity_at",
  company: "company_name COLLATE NOCASE",
  title: "title COLLATE NOCASE",
  deadline_at: "deadline_at IS NULL, deadline_at",
  salary: "COALESCE(salary_max, salary_min) IS NULL, COALESCE(salary_max, salary_min)",
  priority: "CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END",
};

function orderBy(q: Partial<JobListQuery>): string {
  const sort = q.sort ?? "saved_at";
  const dir = q.dir === "asc" ? "ASC" : "DESC";
  // Apply direction to the last term only, so "IS NULL" helpers keep nulls last.
  const parts = SORTS[sort].split(", ");
  const last = parts.pop()!;
  const nullsFirstFlip = sort === "priority" ? (dir === "ASC" ? "ASC" : "DESC") : dir;
  return [...parts, `${last} ${nullsFirstFlip}`, "id ASC"].join(", ");
}

type Row = Record<string, unknown>;

export function rowToListItem(r: Row, tags: TagDTO[]): JobListItem {
  const hasSalary = r.salary_min != null || r.salary_max != null || r.salary_text != null;
  return {
    id: r.id as string,
    job_posting_id: r.job_posting_id as string,
    company_id: r.company_id as string,
    company_name: r.company_name as string,
    company_domain: (r.company_domain as string) ?? null,
    company_logo_url: (r.company_logo_url as string) ?? null,
    title: r.title as string,
    city: (r.city as string) ?? null,
    region: (r.region as string) ?? null,
    country: (r.country as string) ?? null,
    work_mode: r.work_mode as string,
    employment_type: r.employment_type as string,
    source_platform: r.source_platform as string,
    salary: hasSalary
      ? {
          min: (r.salary_min as number) ?? null,
          max: (r.salary_max as number) ?? null,
          currency: (r.salary_currency as string) ?? null,
          period: r.salary_period as Salary["period"],
          source: r.salary_source as Salary["source"],
          text: (r.salary_text as string) ?? null,
          compensation_type: (r.compensation_type as string) ?? null,
        }
      : null,
    deadline_at: (r.deadline_at as number) ?? null,
    posting_status: r.posting_status as string,
    extraction_status: r.extraction_status as JobListItem["extraction_status"],
    status: r.status as JobListItem["status"],
    stage: r.stage as JobListItem["stage"],
    application_id: (r.application_id as string) ?? null,
    application_status: (r.application_status as JobListItem["application_status"]) ?? null,
    priority: (r.priority as JobListItem["priority"]) ?? null,
    is_starred: !!r.is_starred,
    interest_level: (r.interest_level as number) ?? null,
    next_action: (r.next_action as string) ?? null,
    follow_up_at: (r.follow_up_at as number) ?? null,
    saved_at: r.saved_at as number,
    applied_at: (r.applied_at as number) ?? null,
    last_activity_at: r.last_activity_at as number,
    archived_at: (r.archived_at as number) ?? null,
    needs_review_count: Number(r.needs_review_count ?? 0),
    pending_extraction: !!r.pending_extraction,
    tags,
  };
}

export async function tagsForSavedJobs(d1: D1Database, ids: string[]): Promise<Map<string, TagDTO[]>> {
  const map = new Map<string, TagDTO[]>();
  if (!ids.length) return map;
  // Keep bound parameters per statement small (portable SQL); chunk the id list.
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const res = await d1
      .prepare(
        `SELECT jt.saved_job_id, t.id, t.name, t.color FROM job_tags jt JOIN tags t ON t.id = jt.tag_id
         WHERE jt.saved_job_id IN (${part.map(() => "?").join(",")}) ORDER BY t.name COLLATE NOCASE`,
      )
      .bind(...part)
      .all<{ saved_job_id: string; id: string; name: string; color: string | null }>();
    for (const r of res.results) {
      const list = map.get(r.saved_job_id) ?? [];
      list.push({ id: r.id, name: r.name, color: r.color });
      map.set(r.saved_job_id, list);
    }
  }
  return map;
}

export interface ListResult {
  items: JobListItem[];
  total: number;
  salary_filter?: { excluded_unknown: number; excluded_not_comparable: number };
}

export async function listJobs(d1: D1Database, userId: string, q: Partial<JobListQuery>): Promise<ListResult> {
  const inner = buildPostingFilters(userId, q, true);
  const outer = outerFilters(q);
  const cte = `WITH base AS (${BASE_SELECT} WHERE ${inner.where.join(" AND ")})`;
  const outerWhere = outer.where.length ? `WHERE ${outer.where.join(" AND ")}` : "";
  const params = [...inner.params, ...outer.params];

  const pageSize = q.page_size ?? 50;
  const page = q.page ?? 1;
  const [rows, count] = await Promise.all([
    d1
      .prepare(`${cte} SELECT * FROM base ${outerWhere} ORDER BY ${orderBy(q)} LIMIT ? OFFSET ?`)
      .bind(...params, pageSize, (page - 1) * pageSize)
      .all<Row>(),
    d1
      .prepare(`${cte} SELECT COUNT(*) AS n FROM base ${outerWhere}`)
      .bind(...params)
      .first<{ n: number }>(),
  ]);
  const tagMap = await tagsForSavedJobs(
    d1,
    rows.results.map((r) => r.id as string),
  );
  const result: ListResult = {
    items: rows.results.map((r) => rowToListItem(r, tagMap.get(r.id as string) ?? [])),
    total: count?.n ?? 0,
  };

  if (q.salary_min != null) {
    const noSalary = buildPostingFilters(userId, q, false);
    const cur = q.salary_currency ?? "CAD";
    const period = q.salary_period ?? "annually";
    const stats = await d1
      .prepare(
        `WITH base AS (${BASE_SELECT} WHERE ${noSalary.where.join(" AND ")})
         SELECT
           SUM(CASE WHEN salary_min IS NULL AND salary_max IS NULL THEN 1 ELSE 0 END) AS unknown,
           SUM(CASE WHEN (salary_min IS NOT NULL OR salary_max IS NOT NULL)
                     AND (salary_currency IS NULL OR salary_currency <> ? OR salary_period <> ?) THEN 1 ELSE 0 END) AS mismatch
         FROM base ${outerWhere}`,
      )
      .bind(...noSalary.params, cur, period, ...outer.params)
      .first<{ unknown: number | null; mismatch: number | null }>();
    result.salary_filter = {
      excluded_unknown: stats?.unknown ?? 0,
      excluded_not_comparable: stats?.mismatch ?? 0,
    };
  }
  return result;
}

/** All non-archived jobs for the Kanban board (bounded). */
export async function boardJobs(d1: D1Database, userId: string, limit = 1000): Promise<JobListItem[]> {
  const rows = await d1
    .prepare(`${BASE_SELECT} WHERE sj.user_id = ? AND sj.archived_at IS NULL ORDER BY last_activity_at DESC LIMIT ?`)
    .bind(userId, limit)
    .all<Row>();
  const tagMap = await tagsForSavedJobs(
    d1,
    rows.results.map((r) => r.id as string),
  );
  return rows.results.map((r) => rowToListItem(r, tagMap.get(r.id as string) ?? []));
}

export async function listItemsByIds(d1: D1Database, userId: string, ids: string[]): Promise<JobListItem[]> {
  if (!ids.length) return [];
  const rows = await d1
    .prepare(`${BASE_SELECT} WHERE sj.user_id = ? AND sj.id IN (${ids.map(() => "?").join(",")})`)
    .bind(userId, ...ids)
    .all<Row>();
  const tagMap = await tagsForSavedJobs(d1, ids);
  return rows.results.map((r) => rowToListItem(r, tagMap.get(r.id as string) ?? []));
}
