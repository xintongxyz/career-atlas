import { answerSchema, resolveSchema, startApplySchema } from "@shared/apply";
import type { Hono } from "hono";
import { dbOf, jsonBody, userOf } from "../app";
import type { HonoEnv } from "../env";
import { notFound } from "../lib/errors";
import { answerAttempt, applyOverview, approveSubmit, cancelAttempt, continueVisible, getAttempt, getAttemptRow, resolveAttempt, startAttempt } from "../services/apply";

/** Automated applications (local Playwright worker). */
export function registerApplyRoutes(app: Hono<HonoEnv>) {
  app.get("/api/jobs/:id/apply", async (c) => c.json(await applyOverview(dbOf(c), c.env, userOf(c).id, c.req.param("id"))));
  app.post("/api/jobs/:id/apply", async (c) => c.json(await startAttempt(dbOf(c), c.env, userOf(c).id, c.req.param("id"), await jsonBody(c, startApplySchema)), 201));

  app.get("/api/apply/attempts/:aid", async (c) => c.json(await getAttempt(dbOf(c), userOf(c).id, c.req.param("aid"))));
  app.post("/api/apply/attempts/:aid/answers", async (c) => c.json(await answerAttempt(dbOf(c), c.env, userOf(c).id, c.req.param("aid"), await jsonBody(c, answerSchema))));
  app.post("/api/apply/attempts/:aid/approve", async (c) => c.json(await approveSubmit(dbOf(c), c.env, userOf(c).id, c.req.param("aid"))));
  app.post("/api/apply/attempts/:aid/cancel", async (c) => c.json(await cancelAttempt(dbOf(c), c.env, userOf(c).id, c.req.param("aid"))));
  app.post("/api/apply/attempts/:aid/visible", async (c) => c.json(await continueVisible(dbOf(c), c.env, userOf(c).id, c.req.param("aid"))));
  app.post("/api/apply/attempts/:aid/resolve", async (c) => c.json(await resolveAttempt(dbOf(c), userOf(c).id, c.req.param("aid"), (await jsonBody(c, resolveSchema)).outcome)));

  // Local screenshots (may show personal details): owner check, never cached, never framed elsewhere.
  app.get("/api/apply/attempts/:aid/evidence/:name", async (c) => {
    const r = await getAttemptRow(dbOf(c), userOf(c).id, c.req.param("aid"));
    const name = c.req.param("name");
    if (!/^[a-z0-9-]{1,40}\.png$/.test(name) || !((r.evidence as string[] | null) ?? []).includes(name)) throw notFound("evidence");
    const bytes = c.env.APPLY?.readEvidence(r.id, name);
    if (!bytes) throw notFound("evidence");
    return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; img-src 'self'; frame-ancestors 'self'" } });
  });
}
