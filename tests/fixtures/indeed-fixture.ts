// Synthetic Indeed pages for automated tests (served under /indeed/ on 127.0.0.1; test instances
// map these to indeed.com / smartapply.indeed.com shapes). They imitate the two application types
// documented by jiyaa8800/indeed-auto-apply-bot (live-verified there 2026-09-15):
//   - "Apply on company site": button[data-testid="viewjob-apply"] → /applystart → employer site
//   - "Apply now" (Indeed Apply): a[data-testid="viewjob-indeed-apply"] → smartapply …/post-apply
// Career Atlas never clicks or types on Indeed: with `auto=1` the PAGE clicks its own button after a
// moment, standing in for the user. No real Indeed page is contacted by any test.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface IndeedFixtureState {
  /** Indeed Apply submissions (made by the simulated user, never by Career Atlas). */
  submissions: Record<string, string>[];
  /** Any POST the automation made to Indeed pages (must stay empty). */
  automationPosts: string[];
}

export const newIndeedState = (): IndeedFixtureState => ({ submissions: [], automationPosts: [] });

const page = (title: string, body: string, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

export async function indeedRoute(req: IncomingMessage, res: ServerResponse, u: URL, st: IndeedFixtureState): Promise<boolean> {
  if (!u.pathname.startsWith("/indeed/")) return false;
  const send = (code: number, s: string, headers: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(s);
  };
  const jk = u.searchParams.get("jk") ?? "0000000000000000";
  // auto=1: the simulated user clicks Apply and completes Indeed Apply; auto=click: clicks Apply only.
  const auto = u.searchParams.get("auto") === "1";
  const clickOnly = u.searchParams.get("auto") === "click";
  const dest = u.searchParams.get("dest") ?? "";

  if (u.pathname === "/indeed/viewjob") {
    const type = u.searchParams.get("type") ?? "company";
    const cta =
      type === "indeed"
        ? `<a data-testid="viewjob-indeed-apply" href="/indeed/smartapply/beta/indeedapply/form/contact-info?jk=${jk}${auto ? "&auto=1" : ""}">Apply now</a>`
        : `<button data-testid="viewjob-apply" aria-label="Apply on company site (opens in a new tab)" data-href="/indeed/applystart?jk=${jk}&dest=${encodeURIComponent(dest)}">Apply on company site</button>`;
    return (
      send(
        200,
        page(
          "Data Analyst - Northwind Analytics (synthetic) - Indeed",
          `<h1>Data Analyst</h1><p>Northwind Analytics (fictional) · Toronto, ON</p>${cta}`,
          `const b = document.querySelector('[data-testid="viewjob-apply"]');
if (b) b.addEventListener('click', () => window.open(b.dataset.href, '_blank'));
${auto || clickOnly ? `setTimeout(() => document.querySelector('[data-testid^="viewjob-"]').click(), 1200); // the user's click` : ""}`,
        ),
      ),
      true
    );
  }
  if (u.pathname === "/indeed/applystart") return send(302, "", { location: dest }), true;
  if (u.pathname === "/indeed/smartapply/beta/indeedapply/form/contact-info") {
    if (req.method === "POST") {
      const raw = await new Promise<string>((r) => {
        let s = "";
        req.on("data", (c) => (s += c));
        req.on("end", () => r(s));
      });
      const fields = Object.fromEntries(new URLSearchParams(raw));
      if (fields.by === "user") st.submissions.push(fields);
      else st.automationPosts.push(raw.slice(0, 200));
      return send(303, "", { location: "/indeed/smartapply/beta/indeedapply/form/post-apply" }), true;
    }
    return (
      send(
        200,
        page(
          "Indeed Apply",
          `<form method="post"><h2>Add your contact information</h2><label>Full name <input name="name"></label><input type="hidden" name="by" value="user"><button>Continue</button></form>`,
          auto ? `setTimeout(() => { document.querySelector('[name=name]').value = 'Simulated User'; document.forms[0].submit(); }, 1500); // the user completing Indeed Apply` : "",
        ),
      ),
      true
    );
  }
  if (u.pathname === "/indeed/smartapply/beta/indeedapply/form/post-apply") return send(200, page("Application submitted", `<h1>Your application has been submitted!</h1>`)), true;
  return send(404, "not found"), true;
}
