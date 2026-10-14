import { env } from "./harness";
import { describe, expect, it } from "vitest";
import type { ExtractionDTO } from "../../src/shared/types";
import { api, waitFor } from "./helpers";

// Builds a job with every kind of related record (mirrors a real, fully-used job).
async function fullyPopulatedJob(label: string) {
  const text = `${label} Account Executive\n\nResponsibilities:\n• Build pipeline\n• Close deals\n\nRequirements:\n• 5+ years of experience in sales\n\nThis role is hybrid, three days per week in office.`;
  const cap = await api<{ saved_job_id: string; extraction_id: string; job_posting_id: string }>("/api/jobs/capture", { method: "POST", json: { text } });
  const id = cap.body.saved_job_id;
  const ex = await waitFor(async () => {
    const r = await api<ExtractionDTO>(`/api/extractions/${cap.body.extraction_id}`);
    return r.body.result ? r.body : null;
  });
  await api(`/api/extractions/${ex.id}/apply`, { method: "POST", json: { fields: { title: `${label} AE`, company_name: `${label} Co`, work_mode: "hybrid" }, review_later: ["work_mode"] } });
  await api(`/api/jobs/${id}`, { method: "PATCH", json: { job: { work_mode: "onsite" }, personal: { tags: ["delete-test"], follow_up_at: Date.now() + 86_400_000 } } });
  await api(`/api/jobs/${id}/refresh`, { method: "POST" }); // no URL → 400, fine
  await api(`/api/jobs/${id}/extract-text`, { method: "POST", json: { text: text + "\nNew paragraph for a second extraction run." } });
  await api(`/api/jobs/${id}/status`, { method: "POST", json: { status: "applied" } });
  await api(`/api/jobs/${id}/events`, { method: "POST", json: { type: "interview_scheduled", occurred_at: Date.now(), scheduled_for: Date.now() + 3 * 86_400_000, title: "Video call" } });
  await api(`/api/jobs/${id}/status`, { method: "POST", json: { status: "interview" } });
  await api(`/api/jobs/${id}/notes`, { method: "POST", json: { body: "synthetic note" } });
  await api("/api/reminders", { method: "POST", json: { title: "synthetic reminder", kind: "custom", due_at: Date.now() + 86_400_000, saved_job_id: id } });
  return { id, postingId: cap.body.job_posting_id };
}

async function countFor(postingId: string, savedJobId: string) {
  const q = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<{ n: number }>().then((r) => r?.n ?? 0);
  return {
    postings: await q("SELECT COUNT(*) n FROM job_postings WHERE id = ?", postingId),
    saved: await q("SELECT COUNT(*) n FROM saved_jobs WHERE id = ?", savedJobId),
    applications: await q("SELECT COUNT(*) n FROM applications WHERE saved_job_id = ?", savedJobId),
    events: await q("SELECT COUNT(*) n FROM application_events WHERE saved_job_id = ?", savedJobId),
    notes: await q("SELECT COUNT(*) n FROM notes WHERE saved_job_id = ?", savedJobId),
    reminders: await q("SELECT COUNT(*) n FROM reminders WHERE saved_job_id = ?", savedJobId),
    snapshots: await q("SELECT COUNT(*) n FROM job_source_snapshots WHERE job_posting_id = ?", postingId),
    extractions: await q("SELECT COUNT(*) n FROM job_extraction_jobs WHERE job_posting_id = ?", postingId),
    evidence: await q("SELECT COUNT(*) n FROM extracted_field_evidence WHERE job_posting_id = ?", postingId),
    overrides: await q("SELECT COUNT(*) n FROM user_field_overrides WHERE job_posting_id = ?", postingId),
    tags: await q("SELECT COUNT(*) n FROM job_tags WHERE saved_job_id = ?", savedJobId),
  };
}

describe("permanent deletion of a fully populated job", () => {
  it("deletes the job and all its dependent records, and nothing else", async () => {
    const keep = await fullyPopulatedJob("Keep");
    const del = await fullyPopulatedJob("Delete");
    const before = await countFor(del.postingId, del.id);
    expect(before.applications).toBe(1);
    expect(before.events).toBeGreaterThan(3);
    const keepBefore = await countFor(keep.postingId, keep.id);

    const res = await api<{ error?: { code: string; message: string } }>(`/api/jobs/${del.id}`, { method: "DELETE" });
    expect(res.body?.error).toBeUndefined();
    expect(res.status).toBe(204);

    const after = await countFor(del.postingId, del.id);
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    // The other job is untouched.
    expect(await countFor(keep.postingId, keep.id)).toEqual(keepBefore);
    const fk = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
  });
});
