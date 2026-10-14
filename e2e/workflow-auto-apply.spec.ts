import { expect, test } from "@playwright/test";
import { startAtsFixture, type AtsFixture } from "../tests/fixtures/ats-server";

// Runs after the other specs (file order): it leaves an Applied job and a profile in the shared e2e database.
// Automated application through the UI, against a SYNTHETIC Greenhouse-style form on 127.0.0.1.
// The test instance allows loopback targets; the personal instance never does.
test.describe.configure({ mode: "serial" });

const ORIGIN = { origin: "http://127.0.0.1:5174" };
const pdf = (label: string) => Buffer.from(`%PDF-1.4\n% synthetic resume ${label}\n%%EOF\n`);
let fx: AtsFixture;

test.beforeAll(async () => {
  fx = await startAtsFixture();
});
test.afterAll(async () => {
  await fx.close();
});

test("start an application with a chosen resume, answer what the profile doesn't know, and see it verified", async ({ page, request }) => {
  // Fictional applicant and two resume versions.
  await request.put("/api/profile", {
    headers: ORIGIN,
    data: {
      profile: {
        contact: { first_name: "Sam", last_name: "Okafor", email: "sam.okafor@example.test", phone: "+1 416 555 0177" },
        based_in: { city: "Toronto", region: "Ontario", country: "Canada" },
        work_authorization: [{ country: "Canada", status: "citizen" }],
      },
    },
  });
  for (const [name, version] of [
    ["Sam_General.pdf", "General resume"],
    ["Sam_Analytics.pdf", "Analytics resume"],
  ]) {
    const up = await request.post("/api/documents", { headers: ORIGIN, multipart: { file: { name, mimeType: "application/pdf", buffer: pdf(version) }, kind: "resume", version_name: version } });
    expect(up.status()).toBe(201);
  }
  const url = `${fx.url}/greenhouse/northwind/jobs/2001`;
  const res = await request.post("/api/jobs", { headers: ORIGIN, data: { job: { company_name: "Northwind Analytics (synthetic)", title: "Automation Analyst", country: "Canada", original_url: url, apply_url: url }, confirm_duplicate: true } });
  const { id } = (await res.json()) as { id: string };

  await page.goto(`/jobs/${id}`);
  await page.getByRole("button", { name: "Start application" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio", { name: "General resume" })).toBeVisible();
  const start = dialog.getByRole("button", { name: "Start", exact: true });
  await expect(start).toBeDisabled(); // no resume chosen, nothing authorised
  await dialog.getByRole("radio", { name: "Analytics resume" }).check();
  await dialog.getByRole("radio", { name: /Submit automatically/ }).check();
  await expect(start).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Authorize this application" }).click();
  await start.click();

  // Pauses for the open question and the declaration (never guessed / never ticked silently).
  await expect(page.getByText("A declaration needs your approval", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Not applied yet").first()).toBeVisible(); // pipeline status unchanged

  await page.goto("/positions");
  await expect(page.getByRole("row", { name: /Automation Analyst/ }).getByText("Needs review")).toBeVisible();
  await page.goto(`/jobs/${id}?tab=apply`);

  await page.getByLabel(/How did you hear about this job/).fill("Career fair");
  await page.getByRole("checkbox", { name: "I have read this and approve it" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByText("Submission confirmed by the employer's site")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/Applied .*20\d\d/).first()).toBeVisible();
  expect(fx.submissions).toHaveLength(1);
  expect(fx.submissions[0].files[0].filename).toBe("Sam_Analytics.pdf");
  expect(fx.submissions[0].fields.gender).toBe("");
  // A second application for the same job is not offered.
  await expect(page.getByRole("button", { name: "Start application" })).toHaveCount(0);
});

test("unsupported sites get manual assistance instead of automation", async ({ page, request }) => {
  const res = await request.post("/api/jobs", { headers: ORIGIN, data: { job: { company_name: "Contoso (synthetic)", title: "Workday Analyst", original_url: "https://contoso.wd3.myworkdayjobs.com/en-US/careers/job/Toronto/Analyst_R123" }, confirm_duplicate: true } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/jobs/${id}`);
  await page.getByRole("button", { name: "Start application" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Automatic applications are not available for Workday")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy Email" })).toBeVisible();
});
