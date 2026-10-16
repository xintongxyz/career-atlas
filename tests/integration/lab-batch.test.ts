// The lab batch (tests/lab): randomly generated, never-seen career sites with hidden ground truth,
// run through the real application engine (test instance, fictional applicants, review mode). A run is
// approved only when it stopped at the application's own final step; the grader then checks what the
// site RECEIVED. Critical failures fail the test: a wrong applicant value (any wrong phone included), an
// action before approval (a widget used, a declaration ticked, a final Submit), a false completion.
// Everything else is reported as metrics (unhandled patterns are listed, not hidden).
//   npm run test:lab                       (16 sites; CA_LAB_N / CA_LAB_SEED / CA_LAB_REPORT to change)
import type { AttemptDTO } from "@shared/apply";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grade, metrics, report, type RunResult } from "../lab/grade";
import { makeScenario, PROFILE_OF } from "../lab/scenarios";
import { startLab, type LabServer } from "../lab/server";
import { runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const ready = runtime.apply.status().available;
// A small sample inside `npm test`; the larger batch runs on its own (`npm run test:lab`, CI job "lab").
const N = Number(process.env.CA_LAB_N ?? 4);
const FIRST = Number(process.env.CA_LAB_SEED ?? 1);
let lab: LabServer;
let resume: string;
const runs: RunResult[] = [];

const settled = (id: string) =>
  waitFor(async () => {
    const a = (await api<AttemptDTO>(`/api/apply/attempts/${id}`)).body;
    return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(a.state) && a.stage !== "waiting_for_you" ? a : null;
  }, 240_000);

beforeAll(async () => {
  lab = await startLab();
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic lab resume\n%%EOF\n")], "Resume_Lab.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Lab");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterAll(async () => {
  if (runs.length) {
    const m = metrics(runs);
    const text = report(m);
    const out = process.env.CA_LAB_REPORT ?? join(tmpdir(), "career-atlas-lab-report.md");
    writeFileSync(out, `${text}\n`);
    process.stdout.write(`\n${text}\n(report: ${out})\n`);
  }
  await lab?.close();
});

describe.skipIf(!ready)(`lab batch: ${N} generated sites from seed ${FIRST}`, () => {
  for (let seed = FIRST; seed < FIRST + N; seed++) {
    it(`scenario s${seed}`, async () => {
      const sc = makeScenario(seed);
      lab.add(sc);
      await api("/api/profile", { method: "PUT", json: { profile: PROFILE_OF[sc.who] } });
      const job = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: `Lab Employer ${seed} (synthetic)`, title: "Data Analyst", country: "Canada", original_url: `${lab.url}/lab/${sc.id}/${sc.entry}` }, confirm_duplicate: true } })).body.id;
      const attempt = await settled((await api<AttemptDTO>(`/api/jobs/${job}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true } })).body.id);
      const eventsBefore = [...(lab.events.get(sc.id) ?? [])];
      const submissionsBefore = (lab.submissions.get(sc.id) ?? []).length;
      let final: AttemptDTO | undefined;
      if (sc.outcome === "review" && attempt.intervention === "submit_approval") {
        final = await settled((await api<AttemptDTO>(`/api/apply/attempts/${attempt.id}/approve`, { method: "POST" })).body.id);
      }
      const r = grade(sc, attempt, eventsBefore, submissionsBefore, final, (lab.submissions.get(sc.id) ?? [])[0]);
      runs.push(r);
      // Written after every site, so a long batch shows its progress and an interrupted one keeps its results.
      writeFileSync(process.env.CA_LAB_REPORT ?? join(tmpdir(), "career-atlas-lab-report.md"), `${report(metrics(runs))}\n`);
      if (process.env.CA_LAB_TRACE) process.stderr.write(`TRACE ${sc.id} ${JSON.stringify(attempt.steps.map((s) => [s.code, s.params ?? null]))} FILLED ${JSON.stringify(attempt.filled.map((f) => [f.label, f.verified, f.status]))}\n`);
      // Critical failures only (unhandled patterns are reported in the metrics).
      expect(r.unauthorized, `unauthorized actions in ${sc.id}`).toEqual([]);
      expect(r.falseCompletion, `false completion in ${sc.id}`).toBe(false);
      expect(r.fields.filter((f) => f.applicant && f.verdict === "wrong").map((f) => `${f.meaning}: ${f.got}`), `wrong applicant values in ${sc.id}`).toEqual([]);
    }, 420_000);
  }
});
