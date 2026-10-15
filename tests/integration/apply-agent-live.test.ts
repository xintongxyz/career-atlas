// OPT-IN live check of the runtime browser agent with the REAL GPT provider (the owner's ChatGPT
// sign-in through the local Codex CLI, every Codex tool switched off) on the SYNTHETIC unfamiliar
// site and a fictional applicant. Skipped unless CA_LIVE_CODEX=1 — never runs in CI.
//   CA_LIVE_CODEX=1 npx vitest run tests/integration/apply-agent-live.test.ts
// Evidence (observation sent → proposal → Career Atlas's check → executed → verified) is written to
// $CA_AGENT_EVIDENCE (a file outside the repo) when set. Review mode: nothing is submitted.
import type { AttemptDTO } from "@shared/apply";
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexProvider } from "../../src/local/codex";
import { startAtsFixture, type AtsFixture } from "../fixtures/ats-server";
import { agentHook, runtime, SELF } from "./harness";
import { api, waitFor } from "./helpers";

const live = process.env.CA_LIVE_CODEX === "1" && runtime.apply.status().available;
let fx: AtsFixture;
let resume: string;
const evidence = (line: Record<string, unknown>) => {
  if (process.env.CA_AGENT_EVIDENCE) appendFileSync(process.env.CA_AGENT_EVIDENCE, `${JSON.stringify(line)}\n`, { mode: 0o600 });
};

beforeAll(async () => {
  if (!live) return;
  fx = await startAtsFixture();
  await api("/api/profile", { method: "PUT", json: { profile: { contact: { first_name: "Alex", last_name: "Rivera", email: "alex.rivera@example.test" } } } });
  const form = new FormData();
  form.set("file", new File([Buffer.from("%PDF-1.4\n% synthetic\n%%EOF\n")], "Resume_Alex.pdf", { type: "application/pdf" }));
  form.set("kind", "resume");
  form.set("version_name", "Alex");
  resume = ((await (await SELF.fetch("http://localhost/api/documents", { method: "POST", body: form, headers: { origin: "http://localhost" } })).json()) as { id: string }).id;
});
afterAll(async () => {
  agentHook.propose = null;
  await fx?.close();
});

describe.skipIf(!live)("runtime browser agent with the real GPT provider (opt-in, synthetic)", () => {
  it("GPT receives observations and proposes actions; Career Atlas validates, executes and verifies them; stops before Submit", async () => {
    const codex = codexProvider();
    const provider = await codex.ready();
    expect(provider).toBeTruthy();
    const sent: string[] = [];
    agentHook.propose = async (system, user, schema) => {
      sent.push(user);
      const page = (JSON.parse(user) as { page: { url: string; buttons: unknown[]; fields: unknown[] }; last_action_result: string });
      const t0 = Date.now();
      const proposal = (await provider!.completeJson({ system, user, jsonSchema: schema })) as Record<string, unknown>;
      evidence({ kind: "exchange", observation: { url: page.page.url, buttons: page.page.buttons, fields: page.page.fields, last_action_result: page.last_action_result }, proposal, ms: Date.now() - t0 });
      return proposal;
    };
    const id = (await api<{ id: string }>("/api/jobs", { method: "POST", json: { job: { company_name: "Northwind Analytics (synthetic)", title: "Live agent", country: "Canada", original_url: `${fx.url}/pat/agent/1?live=1` }, confirm_duplicate: true } })).body.id;
    const started = (await api<AttemptDTO>(`/api/jobs/${id}/apply`, { method: "POST", json: { resume_document_id: resume, submit_mode: "review", confirm: true } })).body.id;
    const settle = () =>
      waitFor(async () => {
        const x = (await api<AttemptDTO>(`/api/apply/attempts/${started}`)).body;
        return ["needs_review", "submitted_verified", "submission_unconfirmed", "failed", "cancelled"].includes(x.state) && x.stage !== "waiting_for_you" ? x : null;
      }, 900_000);
    let a = await settle();
    // The model may (rightly) treat the office as the applicant's choice: answer as the applicant would.
    const office = a.intervention === "missing_information" ? a.questions.find((q) => /office/i.test(q.label)) : undefined;
    if (office) {
      evidence({ kind: "asked_applicant", questions: a.questions.map((q) => [q.label, q.required]) });
      await api(`/api/apply/attempts/${started}/answers`, { method: "POST", json: { answers: { [office.key]: "Toronto" }, remember: [] } });
      a = await settle();
    }
    evidence({ kind: "result", state: a.state, intervention: a.intervention, error_code: a.error_code, steps: a.steps.map((s) => [s.code, s.params ?? null]), filled: a.filled.map((f) => [f.label, f.source, f.verified]) });
    expect(sent.length).toBeGreaterThan(2);
    expect(a.steps.map((s) => s.code)).toEqual(expect.arrayContaining(["agent_started", "agent_proposed", "agent_verified", "agent_finished"]));
    expect(a).toMatchObject({ state: "needs_review", intervention: "submit_approval" });
    expect(fx.submissions).toEqual([]);
    for (const v of ["Alex", "Rivera", "alex.rivera@example.test", "Resume_Alex"]) expect(sent.join("\n")).not.toContain(v);
  }, 1_000_000);
});
