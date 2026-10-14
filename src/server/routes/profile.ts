import { profileImportSchema } from "@shared/profile";
import type { Hono } from "hono";
import { z } from "zod";
import { dbOf, jsonBody, userOf } from "../app";
import type { HonoEnv } from "../env";
import { acceptProfileDraft, createProfileDraft, discardProfileDraft, getProfile, saveProfile } from "../services/profile";

/** Personal profile (local only). The Claude Desktop extension can only create a draft here. */
export function registerProfileRoutes(app: Hono<HonoEnv>) {
  app.get("/api/profile", async (c) => c.json(await getProfile(dbOf(c), userOf(c).id)));
  app.put("/api/profile", async (c) => c.json(await saveProfile(dbOf(c), userOf(c).id, await jsonBody(c, z.object({ profile: z.unknown(), resume_document_id: z.string().max(64).nullable().optional() })))));
  app.post("/api/profile/drafts", async (c) => c.json(await createProfileDraft(dbOf(c), userOf(c).id, await jsonBody(c, profileImportSchema)), 201));
  app.post("/api/profile/drafts/accept", async (c) => c.json(await acceptProfileDraft(dbOf(c), userOf(c).id, (await jsonBody(c, z.object({ item_ids: z.array(z.string().max(64)).max(400) }))).item_ids)));
  app.post("/api/profile/drafts/discard", async (c) => {
    await discardProfileDraft(dbOf(c), userOf(c).id);
    return c.body(null, 204);
  });
}
