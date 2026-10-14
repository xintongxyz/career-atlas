# Reference project research (2026-10-13)

All four repositories were accessible through the GitHub API. Only product and interaction **ideas** were borrowed. No code, branding or assets were copied.

| Project | License | Stack | What exists (verified) | Ideas used in Career Atlas |
|---|---|---|---|---|
| [Gsync/jobsync](https://github.com/Gsync/jobsync) | MIT | Next.js, Prisma/SQLite | Dashboard, job tracker with a stage timeline, companies, contacts, resumes, tasks/activities, zip backup and restore, AI helpers, Greenhouse/Lever discovery. Statuses: Draft, Applied, Interview, Offer, Offer Accepted/Declined, Rejected, Expired, Archived, Withdrawn | Company ↔ job relationship, activity log, full-data backup with restore, a narrowly scoped AI |
| [offercontext/offerPilot](https://github.com/offercontext/offerPilot) | **AGPL-3.0** (strong copyleft, network clause; nothing copied) | FastAPI, SQLAlchemy | Stage board, JD versions, submission snapshots, first-reached timestamps, offer comparison, soft delete, event timeline | Separate JD snapshots, **first-reached milestone timestamps** for honest conversion analytics, soft delete |
| [hmwheele/job-tracker](https://github.com/hmwheele/job-tracker) | MIT | Single HTML file, localStorage | Drag-and-drop kanban, per-card stage history, `.ics` export, JSON import/export | Minimal kanban cards, stage history timeline, `.ics` export, import/export |
| [rutuu/ApplyTrail](https://github.com/rutuu/ApplyTrail) | MIT | Next.js, NextAuth, Prisma, Gmail API | Gmail sync (`gmail.readonly`), regex classifier with confidence and optional LLM fallback, dedupe by message id, CSV export, 14-day follow-up flag | Confidence labels with human review; email integration architecture for the future (dedupe by message id, sync history, confirm before changing status) |

## Deliberately not adopted

- Mock interviews, question banks, AI resume rewriting and auto-apply (out of scope)
- localStorage as the source of truth
- Automatic status changes from email or elapsed time. Career Atlas requires user confirmation and never infers "Rejected" from silence.
