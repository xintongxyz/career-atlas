# Database schema (SQLite)

Source of truth: `src/server/db/schema.ts`. Migrations: `migrations/*.sql`, generated with `npm run db:generate`, locked in `migrations/LOCK.json`, and applied by the app at startup after a verified backup (applied migrations are recorded in `d1_migrations`, a name kept from the Cloudflare origins).

## Conventions

- Text primary keys (UUID v4) generated in the Worker.
- All timestamps are `INTEGER` epoch milliseconds (UTC). The display time zone is a user preference.
- Every user-owned table has `user_id`, and every query filters by it (single-user today, isolation-ready).
- List-like fields are JSON text arrays.
- History is never rewritten:
  - `application_events` is append-only (manual events are soft-deleted).
  - Milestones are monotonic.
  - Snapshots are immutable.
- Soft delete or archive where recovery matters: `saved_jobs.archived_at`, `deleted_at` on notes, events, reminders and contacts. Permanently deleting a job is an explicit, confirmed action.

## Relationships

```
users 1─1 user_preferences
users 1─* companies 1─* job_postings 1─1 saved_jobs 1─0..1 applications
                                   │          │                 │
                                   │          ├─* application_events (append-only log)
                                   │          ├─* notes
                                   │          ├─* reminders
                                   │          └─* job_tags *─1 tags
                                   ├─* job_extraction_jobs ─0..1 job_source_snapshots
                                   ├─* job_source_snapshots (immutable)
                                   ├─* extracted_field_evidence
                                   └─* user_field_overrides (unique per field)
users 1─* documents *─* applications (application_documents)
saved_jobs / applications ─0..1 documents (resume, cover letter)
users 1─* contacts ─0..1 companies;  saved_jobs → referral/recruiter contact
users 1─* custom_views
```

## Tables

| Table | Purpose | Notable columns / rules |
|---|---|---|
| `users` | Local identity mapped from the verified auth identity | `email` unique |
| `user_preferences` | Locale, time zone (default `America/Toronto`), default follow-up days (7), comparison preferences (JSON) | PK `user_id` |
| `companies` | One company → many postings | `normalized_name`, `domain` used for de-duplication |
| `job_postings` | Employer facts | Identity: `external_job_id`, `original_url`, `canonical_url`, `apply_url`, `source_platform`. Arrangement: `work_mode` remote/hybrid/onsite/unspecified, location columns, `remote_eligible_regions` (separate from remote). Compensation: `salary_min/max`, `salary_currency`, `salary_period` (hourly…annually/other/unknown), `salary_source` (employer/third_party/user_estimate/unknown), `salary_text`. Description and requirement lists. Eligibility columns (`work_authorization` ≠ `visa_sponsorship`). Extraction summary: `extraction_status`, `latest_extraction_id`, `last_checked_at` |
| `saved_jobs` | *My* relationship to a posting | Unique (`user_id`, `job_posting_id`). `stage` saved/preparing/closed, star, priority, interest, fit (kept separate from employer requirements), next action, follow-up, materials, contacts, `archived_at` |
| `applications` | Exists only after applying | Unique per saved job. `status`, `applied_at`, `first_response_at`, `last_response_at`, `next_follow_up_at`, `next_interview_at`, `offer_deadline_at`, `final_outcome_at`. **Milestones** `reached_assessment_at`, `reached_interview_at`, `reached_offer_at` are set once and never cleared |
| `application_events` | Timeline | `type`, `from_status`, `to_status`, `occurred_at` (editable), `scheduled_for`. Lifecycle events cannot be deleted |
| `job_extraction_jobs` | Each extraction or refresh run | `status` queued/fetching/extracting/succeeded/partial/needs_review/access_restricted/failed, `attempts`, `error_code`, `result` (candidates with provenance), `applied_at`, `dismissed_at` |
| `job_source_snapshots` | Immutable copy of what was fetched or pasted | `method` (ats_api/html/pasted_text), URLs, HTTP status, `text`, `structured_data`, `content_hash` |
| `extracted_field_evidence` | Per-field provenance | `value`, `source`, `evidence` (verbatim quote), `confidence`, `review_status` needs_review/confirmed/overridden/superseded |
| `user_field_overrides` | Manual edits of extracted fields | Unique (`job_posting_id`, `field`); keeps `original_value`. Refresh never overwrites these by default |
| `notes`, `tags`, `job_tags` | Personal notes and labels | Tags unique per user (case-insensitive). Tags attach to the saved job (one application per saved job, so application-level tags would duplicate) |
| `documents`, `application_documents` | File metadata. Content lives in the local documents folder under random keys | `r2_key` (historical name: the file's key on disk) is never exposed. `sha256`, size, MIME validated by magic bytes |
| `contacts` | Recruiters, referrals | Optional company |
| `reminders` | In-app to-dos and calendar items | `kind`, `due_at`, `completed_at`, `auto_key` for system-created reminders (follow-up, manual follow-up date, event-linked) |
| `custom_views` | Saved table filters and columns | `state` JSON |

## Duplicate detection

`services/jobs.ts › findDuplicates` returns *possible* duplicates and never blocks silently. It checks three things:

1. Same platform + external job ID.
2. Same canonical URL. Canonicalisation removes tracking parameters but keeps job identifiers such as `gh_jid`, `jk`, `currentJobId`, `jobId`, `id` and `token`.
3. Same normalized company + same title (+ same city when known), flagged as "similar".

The user can view the existing job, save anyway or cancel. Reposted jobs are new postings (new saved job). The closed one keeps its history.

## Integrity notes

- Status changes and their events are written in a single atomic batch (one transaction).
- **Query style.** `IN (…)` lists are chunked (≤ 100 parameters) and wide joins split; this was required by Cloudflare D1 and keeps queries portable.
- **Foreign keys:** cascades from postings to saved jobs, applications, events, notes, snapshots and evidence. Document and contact links use `SET NULL`.
- **Backups:** weekly encrypted, verified backups of the whole database and documents (docs/LOCAL_FIRST.md). The JSON export contains every user row except file keys; file contents are not included in it.
