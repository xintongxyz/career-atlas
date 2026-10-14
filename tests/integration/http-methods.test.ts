import { SELF } from "./harness";
import { describe, expect, it } from "vitest";
import { api, manualJob } from "./helpers";

// Browsers and proxies may deliver body-less DELETE/POST requests with an empty
// body and `Content-Length: 0` but no Content-Type. These must not be rejected as an
// unsupported media type (regression: job deletion failed on the deployed Preview).
describe("body-less write requests", () => {
  it("DELETE with Content-Length: 0 and no Content-Type succeeds", async () => {
    const created = await api<{ id: string }>("/api/jobs", { method: "POST", json: manualJob({ company_name: "Empty Body Co", title: "Delete Me" }) });
    const res = await SELF.fetch(`http://localhost/api/jobs/${created.body.id}`, { method: "DELETE", body: "", headers: { origin: "http://localhost", "content-length": "0" } });
    expect(res.status).toBe(204);
    expect((await api(`/api/jobs/${created.body.id}`)).status).toBe(404);
  });

  it("still rejects a non-empty body with a non-JSON content type", async () => {
    const res = await SELF.fetch("http://localhost/api/jobs", { method: "POST", body: "a=b", headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(415);
  });
});
