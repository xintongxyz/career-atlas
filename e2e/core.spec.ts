import { expect, test, type Page } from "@playwright/test";

async function addManualJob(page: Page, { company, title, city }: { company: string; title: string; city: string }) {
  await page.getByRole("button", { name: "Add job" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Manual entry" }).click();
  await dialog.getByLabel("Company", { exact: true }).fill(company);
  await dialog.getByLabel("Job title", { exact: true }).fill(title);
  await dialog.getByLabel("City").fill(city);
  await dialog.getByLabel("Minimum").fill("70000");
  await dialog.getByLabel("Maximum").fill("85000");
  await dialog.getByLabel("Currency").fill("CAD");
  await dialog.getByRole("combobox", { name: /Unknown|Annually/ }).first().selectOption("annually");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\//);
}

test.describe.configure({ mode: "serial" });

test("Test 1 & 8 — manual job is persisted across reloads and new sessions", async ({ page, browser }) => {
  await page.goto("/");
  await addManualJob(page, { company: "Northwind Analytics", title: "Data Analyst", city: "Toronto" });
  await expect(page.getByRole("heading", { name: "Data Analyst" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Data Analyst" })).toBeVisible();
  await expect(page.getByText("Toronto").first()).toBeVisible();
  await expect(page.getByText(/70,000/).first()).toBeVisible();
  // A brand-new browser context (like closing the browser) still sees the data.
  const ctx = await browser.newContext();
  const fresh = await ctx.newPage();
  await fresh.goto("/positions");
  await expect(fresh.getByRole("link", { name: "Data Analyst" })).toBeVisible();
  await ctx.close();
});

test("Test 4 — saving the same job again warns about a duplicate", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add job" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Manual entry" }).click();
  await dialog.getByLabel("Company", { exact: true }).fill("Northwind Analytics");
  await dialog.getByLabel("Job title", { exact: true }).fill("Data Analyst");
  await dialog.getByLabel("City").fill("Toronto");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByText("Possible duplicate found")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "View existing" })).toBeVisible();
});

test("Test 5 — saved is not applied; marking applied updates the dashboard", async ({ page }) => {
  await page.goto("/");
  const applications = page.getByRole("link", { name: /Applications/ }).filter({ has: page.locator("p.text-2xl") });
  await expect(applications.locator("p.text-2xl")).toHaveText("0");
  await page.goto("/positions");
  await page.getByRole("link", { name: "Data Analyst" }).click();
  await page.getByRole("tab", { name: "Application" }).click();
  await page.getByRole("button", { name: "Mark as applied" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText(/Applied .*20\d\d/).first()).toBeVisible();
  await page.goto("/");
  await expect(applications.locator("p.text-2xl")).toHaveText("1");
});

test("Test 6 — status history is preserved", async ({ page }) => {
  await page.goto("/positions");
  await page.getByRole("link", { name: "Data Analyst" }).click();
  for (const status of ["Interview", "Rejected"]) {
    await page.getByRole("button", { name: "Change status" }).first().click();
    await page.getByRole("menuitem", { name: status }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText("Status: Interview → Rejected")).toBeVisible();
  await expect(page.getByText("Status: Applied → Interview")).toBeVisible();
  await expect(page.getByText("Applied", { exact: true }).first()).toBeVisible();
});

test("Test 3 — pasted description without salary keeps salary unknown", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add job" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: "Paste description" }).click();
  await dialog.getByLabel("Job description").fill(
    "Operations Analyst\n\nThis is a hybrid role based in Ottawa, two days per week in office.\n\nResponsibilities:\n• Maintain reporting\n• Support planning\n\nRequirements:\n• 2+ years of experience in operations\n• Must be legally authorized to work in Canada",
  );
  await dialog.getByRole("button", { name: "Save & extract" }).click();
  await expect(page.getByRole("heading", { name: "Review extracted details" })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText("Salary", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Save selected fields" }).click();
  await expect(page).toHaveURL(/\/jobs\//);
  await expect(page.getByText("Not disclosed").first()).toBeVisible();
});

test("Test 7 — switching languages keeps pages fully translated", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("radio", { name: "中文" }).first().click();
  const pages: [string, string][] = [
    ["/", "总览"],
    ["/saved", "收藏职位"],
    ["/applications", "投递管理"],
    ["/positions", "全部职位"],
    ["/calendar", "日程与时间线"],
    ["/analytics", "求职分析"],
    ["/documents", "求职材料"],
    ["/settings", "设置"],
  ];
  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    // No untranslated i18n keys (e.g. "dashboard.title") leak into the UI.
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/\b(nav|actions|common|status|fields|dashboard|positions|job|extraction|settings|analytics)\.[a-z_]+/);
  }
  // Switching back preserves the current page and state.
  await page.goto("/positions?q=Data");
  await page.getByRole("radio", { name: "EN" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "All Positions" })).toBeVisible();
  await expect(page).toHaveURL(/q=Data/);
  await expect(page.getByPlaceholder("Search title, company, city…")).toHaveValue("Data");
});

test("Test 9 — the API rejects cross-site writes", async ({ request }) => {
  const res = await request.post("/api/jobs", { headers: { origin: "https://evil.example", "content-type": "application/json" }, data: { job: { company_name: "X", title: "Y" } } });
  expect(res.status()).toBe(403);
});

test("Archive, restore and permanent deletion with impact summary", async ({ page, request }) => {
  const res = await request.post("/api/jobs", { headers: { origin: "http://127.0.0.1:5174" }, data: { job: { company_name: "Lifecycle Co", title: "Lifecycle Analyst" }, confirm_duplicate: true } });
  const { id } = (await res.json()) as { id: string };
  await request.post(`/api/jobs/${id}/notes`, { headers: { origin: "http://127.0.0.1:5174" }, data: { body: "synthetic note" } });
  await page.goto(`/jobs/${id}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await expect(page.getByText("This job is archived.")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).first().click();
  await expect(page.getByText("This job is archived.")).toBeHidden();

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete permanently" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("1 note")).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Delete permanently" });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("checkbox").click();
  await confirm.click();
  await expect(page).toHaveURL(/\/positions/);
  expect((await request.get(`/api/jobs/${id}`)).status()).toBe(404);
});
