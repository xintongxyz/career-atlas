// Serves lab scenarios (tests/lab/scenarios.ts) on 127.0.0.1 and records what the "site" receives:
// client events (widget use, ticking declarations, the final Submit) and form submissions.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Scenario } from "./scenarios";

export interface LabSubmission {
  fields: Record<string, string | string[]>;
  files: { field: string; filename: string; size: number }[];
}

export interface LabServer {
  url: string;
  add: (s: Scenario) => void;
  events: Map<string, string[]>;
  submissions: Map<string, LabSubmission[]>;
  close: () => Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

export async function startLab(): Promise<LabServer> {
  const scenarios = new Map<string, Scenario>();
  const events = new Map<string, string[]>();
  const submissions = new Map<string, LabSubmission[]>();
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const m = u.pathname.match(/^\/lab\/(s\d+)\/([\w-]+)$/);
    const s = m ? scenarios.get(m[1]) : undefined;
    if (!m || !s) {
      res.writeHead(404);
      return res.end("not found");
    }
    const [, sid, page] = m;
    const ev = (e: string) => events.set(sid, [...(events.get(sid) ?? []), e]);
    if (page === "log") {
      ev(String(u.searchParams.get("ev")));
      res.writeHead(204);
      return res.end();
    }
    if (page === "submit" && req.method === "POST") {
      const raw = await readBody(req);
      const form = await new Response(raw, { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
      const sub: LabSubmission = { fields: {}, files: [] };
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") {
          const prev = sub.fields[k];
          sub.fields[k] = prev === undefined ? v : ([] as string[]).concat(prev, v);
        } else if (v.size) sub.files.push({ field: k, filename: v.name, size: v.size });
      }
      submissions.set(sid, [...(submissions.get(sid) ?? []), sub]);
      res.writeHead(303, { location: `/lab/${sid}/thanks` });
      return res.end();
    }
    if (page === "thanks") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!doctype html><html><body><h1>Thank you for applying.</h1><p>Your application has been received.</p></body></html>");
    }
    if (page === "register") ev("register_opened");
    const html = s.pages[page];
    if (!html) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    add: (s) => scenarios.set(s.id, s),
    events,
    submissions,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
