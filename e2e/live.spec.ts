import { expect, test } from "@playwright/test";

// Test 2 — real URL import against live public job boards. Opt-in (network + third-party
// availability): run with `LIVE=1 npm run test:e2e -- live`. Each case first looks up a
// currently open posting through the board's public API, so no URL is hard-coded.
test.skip(!process.env.LIVE, "set LIVE=1 to run live extraction tests");

const sources: { name: string; find: () => Promise<string | null> }[] = [
  {
    name: "Greenhouse",
    find: async () => {
      const r = await fetch("https://boards-api.greenhouse.io/v1/boards/discord/jobs");
      const d = (await r.json()) as { jobs?: { id: number }[] };
      return d.jobs?.[0] ? `https://job-boards.greenhouse.io/discord/jobs/${d.jobs[0].id}` : null;
    },
  },
  {
    name: "Ashby",
    find: async () => {
      const r = await fetch("https://api.ashbyhq.com/posting-api/job-board/ramp");
      const d = (await r.json()) as { jobs?: { jobUrl: string }[] };
      return d.jobs?.[0]?.jobUrl ?? null;
    },
  },
];

for (const s of sources) {
  test(`imports a live ${s.name} posting`, async ({ page, request }) => {
    const url = await s.find();
    test.skip(!url, `no open ${s.name} posting found`);
    const cap = await request.post("/api/jobs/capture", { headers: { origin: "http://127.0.0.1:5174" }, data: { url, confirm_duplicate: true } });
    expect(cap.status()).toBe(202);
    const { extraction_id, saved_job_id } = (await cap.json()) as { extraction_id: string; saved_job_id: string };
    let ex: { status: string; adapter: string; result: { fields: Record<string, { value: unknown }>; description_text: string } | null } | null = null;
    await expect
      .poll(async () => {
        ex = await (await request.get(`/api/extractions/${extraction_id}`)).json();
        return ex!.status;
      }, { timeout: 45_000 })
      .toMatch(/succeeded|partial|needs_review|failed|access_restricted/);
    expect(ex!.status).toMatch(/succeeded|partial|needs_review/);
    expect(ex!.adapter).toBe(s.name.toLowerCase());
    expect(String(ex!.result!.fields.title?.value ?? "")).not.toBe("");
    expect(ex!.result!.description_text.length).toBeGreaterThan(200);
    await page.goto(`/jobs/${saved_job_id}`);
    await expect(page.getByText("Extracted details are ready to review.")).toBeVisible();
  });
}
