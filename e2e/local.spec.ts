import { expect, test } from "@playwright/test";

// Local-first behaviour on the production-like server (synthetic data only).
test.describe.configure({ mode: "serial" });

const ORIGIN = { origin: "http://127.0.0.1:5174" };

test("autosave: typed text is saved without leaving the field and survives a reload", async ({ page, request }) => {
  const res = await request.post("/api/jobs", { headers: ORIGIN, data: { job: { company_name: "Autosave Co", title: "Autosave Analyst" }, confirm_duplicate: true } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/jobs/${id}`);
  const field = page.getByLabel("Next action", { exact: true });
  await field.click();
  await field.pressSequentially("Email the recruiter");
  // No blur: the debounce alone must save it.
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 5000 });
  await page.reload();
  await expect(page.getByLabel("Next action", { exact: true })).toHaveValue("Email the recruiter");
});

test("pasted job description is saved immediately and extracted in the background", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add job" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Paste description" }).click();
  await dialog
    .getByLabel("Job description")
    .fill("Junior Data Analyst at Fabrikam Research (fictional). Location: Montréal, QC, Canada. Hybrid: 2 days per week in office. Full-time. Salary CAD $60,000 – $70,000 per year. Requirements: SQL, Excel, 1+ years of experience. Must be legally authorized to work in Canada.");
  await dialog.getByRole("button", { name: "Save & extract" }).click();
  await expect(dialog.getByRole("heading", { name: "Review extracted details" })).toBeVisible({ timeout: 15_000 });
});

test("Settings shows local storage and can back up and test-restore", async ({ page }) => {
  await page.goto("/settings");
  const local = page.locator("#local-data");
  await expect(local.getByRole("heading", { name: "Local data" })).toBeVisible();
  await expect(local.getByText("Automatic")).toBeVisible();
  await local.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText(/Encrypted backup created and verified/)).toBeVisible({ timeout: 20_000 });
  await local.getByRole("button", { name: "Test restore" }).click();
  await expect(page.getByText(/restored cleanly into a test database/)).toBeVisible({ timeout: 20_000 });
  // AI is off by default and clearly labelled as an online service.
  await expect(page.locator("#local-ai").getByText(/uses an online service/)).toBeVisible();
});

test("Chinese interface works on the local server", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("radio", { name: "中文" }).first().click();
  await expect(page.locator("#local-data").getByRole("heading", { name: "本地数据" })).toBeVisible();
  await expect(page.locator("#local-data").getByText("自动保存")).toBeVisible();
  await page.getByRole("radio", { name: "EN" }).first().click();
});

test("local file upload: a resume is stored on disk, listed and downloadable", async ({ page, request }) => {
  await page.goto("/documents");
  await page.getByRole("button", { name: "Upload document" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("File").setInputFiles({ name: "synthetic-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% synthetic test resume\n") });
  await dialog.getByLabel("Version name").fill("Synthetic resume v1");
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByText("Document uploaded")).toBeVisible();
  await expect(page.getByText("Synthetic resume v1")).toBeVisible();
  const list = (await (await request.get("/api/documents")).json()) as { items: { id: string; size_bytes: number }[] };
  const res = await request.get(`/api/documents/${list.items[0].id}/content`);
  expect(res.status()).toBe(200);
  expect((await res.body()).toString()).toContain("synthetic test resume");
});

test("offline core: the app loads nothing from the internet", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (!["127.0.0.1", "localhost"].includes(host) && !r.url().startsWith("data:")) external.push(host);
  });
  for (const path of ["/", "/saved", "/applications", "/positions", "/calendar", "/analytics", "/documents", "/settings"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  // A pasted description is extracted entirely on this computer (no fetch, AI off).
  await page.getByRole("button", { name: "Add job" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Paste description" }).click();
  await dialog.getByLabel("Job description").fill("Offline Analyst at Tailspin Toys (fictional). Location: Ottawa, ON. Remote within Canada. Full-time. Salary CAD $65,000 – $75,000 per year. Requirements: SQL and Excel.");
  await dialog.getByRole("button", { name: "Save & extract" }).click();
  await expect(dialog.getByRole("heading", { name: "Review extracted details" })).toBeVisible({ timeout: 15_000 });
  expect(external).toEqual([]);
});
