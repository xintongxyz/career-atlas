import { aiImportSchema, draftSaveSchema } from "@shared/schemas";
import type { Hono } from "hono";
import { dbOf, jsonBody, userOf } from "../app";
import type { HonoEnv } from "../env";
import { createDraft, discardDraft, getDraft, listDrafts, saveDraft } from "../services/drafts";

/**
 * AI drafts. The Claude Desktop extension can only call POST /api/drafts (create a draft) and
 * POST /api/jobs/check-duplicates; saving always happens here, after the user reviews in the app.
 */
export function registerDraftRoutes(app: Hono<HonoEnv>) {
  app.get("/api/drafts", async (c) => c.json({ items: await listDrafts(dbOf(c), userOf(c).id) }));
  app.post("/api/drafts", async (c) => c.json(await createDraft(dbOf(c), userOf(c).id, await jsonBody(c, aiImportSchema)), 201));
  app.get("/api/drafts/:id", async (c) => c.json(await getDraft(dbOf(c), userOf(c).id, c.req.param("id"))));
  app.post("/api/drafts/:id/save", async (c) => c.json(await saveDraft(dbOf(c), userOf(c).id, c.req.param("id"), await jsonBody(c, draftSaveSchema))));
  app.post("/api/drafts/:id/discard", async (c) => {
    await discardDraft(dbOf(c), userOf(c).id, c.req.param("id"));
    return c.body(null, 204);
  });
}
