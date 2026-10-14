import { createExecutionContext, env } from "./harness";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";

describe("read-only maintenance mode", () => {
  const app = createApp();
  const roEnv = { ...env, MAINTENANCE_MODE: "read_only" } as unknown as Parameters<typeof app.fetch>[1];
  it("allows reads", async () => {
    const res = await app.fetch(new Request("http://localhost/api/me"), roEnv, createExecutionContext());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { config: { read_only: boolean } }).config.read_only).toBe(true);
  });
  it("rejects every write", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/jobs", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ job: { company_name: "X", title: "Y" } }) }),
      roEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("maintenance_read_only");
  });
});
