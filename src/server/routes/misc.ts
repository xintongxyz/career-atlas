import { DOCUMENT_KINDS } from "@shared/constants";
import {
  analyticsQuerySchema,
  companyUpdateSchema,
  contactSchema,
  customViewSchema,
  documentMetaSchema,
  importSchema,
  preferencesSchema,
  reminderSchema,
  reminderUpdateSchema,
  tagSchema,
} from "@shared/schemas";
import type { Hono } from "hono";
import { z } from "zod";
import { dbOf, jsonBody, parseBody, queryParams, userOf } from "../app";
import type { HonoEnv } from "../env";
import { ApiError } from "../lib/errors";
import { buildIcs, calendarItems, createReminder, deleteReminder, listEvents, listReminders, updateReminder } from "../services/activity";
import { exportCsv, exportJson, importJson } from "../services/backup";
import { getCompany, listCompanies, updateCompany } from "../services/companies";
import { deleteDocument, documentResponse, listDocuments, updateDocument, uploadDocument } from "../services/documents";
import { getAnalytics, getDashboard } from "../services/insights";
import { companyToDTO } from "../services/mappers";
import { createContact, deleteContact, deleteView, globalSearch, listContacts, listViews, saveView, updateContact } from "../services/misc";
import { createTag, deleteTag, listTags, updateTag } from "../services/tags";
import { appConfig, getPreferences, updatePreferences } from "../services/users";

const ICS_LABELS: Record<"en" | "zh-CN", Record<string, string>> = {
  en: { follow_up: "Follow up", interview: "Interview", deadline: "Application deadline", offer_deadline: "Offer response deadline", applied: "Applied", reminder: "Reminder", follow_up_default: "Follow up on application", interview_default: "Interview", offer_deadline_default: "Offer response deadline" },
  "zh-CN": { follow_up: "跟进", interview: "面试", deadline: "申请截止", offer_deadline: "Offer答复期限", applied: "已投递", reminder: "提醒", follow_up_default: "跟进申请进度", interview_default: "面试", offer_deadline_default: "Offer答复期限" },
};

const rangeQuery = z.object({ from: z.coerce.number().int(), to: z.coerce.number().int(), lang: z.enum(["en", "zh-CN"]).default("en") });

export function registerMiscRoutes(app: Hono<HonoEnv>) {
  // ---------- me / preferences ----------
  app.get("/api/me", async (c) => {
    const user = userOf(c);
    return c.json({ user, preferences: await getPreferences(dbOf(c), user.id), config: appConfig(c.env) });
  });
  app.patch("/api/me/preferences", async (c) => {
    const body = await jsonBody(c, preferencesSchema);
    return c.json(await updatePreferences(dbOf(c), userOf(c).id, body));
  });

  // ---------- dashboard / analytics / search ----------
  app.get("/api/dashboard", async (c) => {
    const prefs = await getPreferences(dbOf(c), userOf(c).id);
    return c.json(await getDashboard(dbOf(c), userOf(c).id, prefs.timezone));
  });
  app.get("/api/analytics", async (c) => {
    const q = queryParams(c, analyticsQuerySchema);
    const prefs = await getPreferences(dbOf(c), userOf(c).id);
    return c.json(await getAnalytics(dbOf(c), userOf(c).id, q, prefs.timezone));
  });
  app.get("/api/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    if (!q) return c.json({ jobs: [], companies: [] });
    return c.json(await globalSearch(dbOf(c), userOf(c).id, q));
  });
  app.get("/api/events", async (c) => {
    const q = parseBody(
      z.object({ saved_job_id: z.string().max(64).optional(), company_id: z.string().max(64).optional(), from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
      c.req.query(),
    );
    return c.json({ items: await listEvents(dbOf(c), userOf(c).id, q) });
  });

  // ---------- companies ----------
  app.get("/api/companies", async (c) => c.json({ items: await listCompanies(dbOf(c), userOf(c).id) }));
  app.get("/api/companies/:id", async (c) => c.json(companyToDTO(await getCompany(dbOf(c), userOf(c).id, c.req.param("id")))));
  app.patch("/api/companies/:id", async (c) => c.json(await updateCompany(dbOf(c), userOf(c).id, c.req.param("id"), await jsonBody(c, companyUpdateSchema))));

  // ---------- tags ----------
  app.get("/api/tags", async (c) => c.json({ items: await listTags(dbOf(c), userOf(c).id) }));
  app.post("/api/tags", async (c) => {
    const body = await jsonBody(c, tagSchema);
    return c.json(await createTag(dbOf(c), userOf(c).id, body.name, body.color), 201);
  });
  app.patch("/api/tags/:id", async (c) => c.json(await updateTag(dbOf(c), userOf(c).id, c.req.param("id"), await jsonBody(c, tagSchema.partial()))));
  app.delete("/api/tags/:id", async (c) => {
    await deleteTag(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------- reminders / calendar ----------
  app.get("/api/reminders", async (c) => {
    const q = parseBody(z.object({ status: z.enum(["open", "completed", "all"]).default("open"), saved_job_id: z.string().max(64).optional(), due_before: z.coerce.number().int().optional() }), c.req.query());
    return c.json({ items: await listReminders(dbOf(c), userOf(c).id, q) });
  });
  app.post("/api/reminders", async (c) => {
    const body = await jsonBody(c, reminderSchema);
    return c.json({ id: await createReminder(dbOf(c), userOf(c).id, body) }, 201);
  });
  app.patch("/api/reminders/:id", async (c) => {
    await updateReminder(dbOf(c), userOf(c).id, c.req.param("id"), await jsonBody(c, reminderUpdateSchema));
    return c.body(null, 204);
  });
  app.delete("/api/reminders/:id", async (c) => {
    await deleteReminder(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/api/calendar", async (c) => {
    const q = parseBody(rangeQuery, c.req.query());
    if (q.to - q.from > 400 * 86_400_000) throw new ApiError(400, "range_too_large", "Date range too large");
    return c.json({ items: await calendarItems(dbOf(c), userOf(c).id, q.from, q.to) });
  });
  app.get("/api/calendar.ics", async (c) => {
    const q = parseBody(rangeQuery, c.req.query());
    const labels = ICS_LABELS[q.lang];
    const items = (await calendarItems(dbOf(c), userOf(c).id, q.from, q.to)).filter((i) => !i.completed);
    const ics = buildIcs(
      items.map((i) => ({
        uid: i.id.replace(/:/g, "-"),
        start: i.at,
        summary: `${labels[i.title] ?? (i.kind === "reminder" ? i.title : labels[i.kind])}${i.company_name ? ` — ${i.company_name}` : ""}${i.job_title ? ` · ${i.job_title}` : ""}`,
        description: i.kind === "reminder" ? i.title : null,
      })),
    );
    return c.body(ics, 200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="career-atlas.ics"' });
  });

  // ---------- documents ----------
  app.get("/api/documents", async (c) => c.json({ items: await listDocuments(dbOf(c), userOf(c).id) }));
  app.post("/api/documents", async (c) => {
    const form = await c.req.formData().catch(() => {
      throw new ApiError(400, "invalid_form", "Expected multipart form data");
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "file_required", "File is required");
    const meta = parseBody(documentMetaSchema, { kind: form.get("kind"), version_name: form.get("version_name"), notes: form.get("notes") ?? null });
    return c.json(await uploadDocument(dbOf(c), c.env, userOf(c).id, file, meta), 201);
  });
  app.get("/api/documents/:id/content", async (c) => documentResponse(dbOf(c), c.env, userOf(c).id, c.req.param("id"), c.req.query("disposition") === "inline"));
  app.patch("/api/documents/:id", async (c) => {
    await updateDocument(dbOf(c), userOf(c).id, c.req.param("id"), await jsonBody(c, z.object({ kind: z.enum(DOCUMENT_KINDS).optional(), version_name: z.string().trim().min(1).max(200).optional(), notes: z.string().max(2000).nullable().optional() })));
    return c.body(null, 204);
  });
  app.delete("/api/documents/:id", async (c) => {
    await deleteDocument(dbOf(c), c.env, userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------- contacts ----------
  app.get("/api/contacts", async (c) => c.json({ items: await listContacts(dbOf(c), userOf(c).id) }));
  app.post("/api/contacts", async (c) => c.json({ id: await createContact(dbOf(c), userOf(c).id, await jsonBody(c, contactSchema)) }, 201));
  app.patch("/api/contacts/:id", async (c) => {
    await updateContact(dbOf(c), userOf(c).id, c.req.param("id"), await jsonBody(c, contactSchema.partial()));
    return c.body(null, 204);
  });
  app.delete("/api/contacts/:id", async (c) => {
    await deleteContact(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------- saved views ----------
  app.get("/api/views", async (c) => c.json({ items: await listViews(dbOf(c), userOf(c).id, c.req.query("page") ?? "positions") }));
  app.post("/api/views", async (c) => c.json({ id: await saveView(dbOf(c), userOf(c).id, await jsonBody(c, customViewSchema)) }, 201));
  app.put("/api/views/:id", async (c) => c.json({ id: await saveView(dbOf(c), userOf(c).id, await jsonBody(c, customViewSchema), c.req.param("id")) }));
  app.delete("/api/views/:id", async (c) => {
    await deleteView(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  // ---------- backup ----------
  app.get("/api/export/json", async (c) => {
    const data = await exportJson(dbOf(c), userOf(c).id);
    const day = new Date().toISOString().slice(0, 10);
    return c.body(JSON.stringify(data, null, 2), 200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="career-atlas-export-${day}.json"` });
  });
  app.post("/api/export/csv", async (c) => {
    const body = await jsonBody(c, z.object({ headers: z.record(z.string(), z.string().max(80)).default({}), status_labels: z.record(z.string(), z.string().max(80)).default({}) }));
    const csv = await exportCsv(dbOf(c), userOf(c).id, body.headers, body.status_labels);
    const day = new Date().toISOString().slice(0, 10);
    return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="career-atlas-jobs-${day}.csv"` });
  });
  app.post("/api/import", async (c) => {
    if (c.env.APP_ENV === "demo") throw new ApiError(403, "demo_readonly", "Import is disabled in the demo");
    const body = await jsonBody(c, importSchema);
    return c.json(await importJson(dbOf(c), userOf(c).id, body.data, body.mode));
  });
}
