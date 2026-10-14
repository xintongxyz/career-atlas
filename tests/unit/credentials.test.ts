import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountManager, generatePassword, memoryStore, passwordProblems, tenantOf } from "../../src/local/apply/credentials";

describe("Workday credentials (in-memory store; the real Keychain is never used in tests)", () => {
  it("generated passwords meet common Workday rules and differ every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(passwordProblems(p)).toEqual([]);
      expect(p).toHaveLength(20);
      expect(p).not.toMatch(/["'\\\s]/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
    expect(passwordProblems("weakpass")).toEqual(["upper", "digit", "special"]);
  });

  it("the index holds no secrets; failures block automatic retries; forgetting removes the secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ca-acc-"));
    let mode: "unique" | "shared" = "unique";
    const acc = accountManager({ store: memoryStore(), dir, settings: () => ({ mode, autoSignIn: true }) });
    const tenant = tenantOf("https://acme.wd3.myworkdayjobs.com/en-US/External/job/x_R1");
    expect(tenant).toBe("acme.wd3.myworkdayjobs.com");
    const np = (await acc.newPassword())!;
    await acc.save(tenant, "Pat@Example.test", np.password, np.mode, "created");
    expect(await acc.password(tenant, "pat@example.test")).toBe(np.password);
    const file = readFileSync(join(dir, "accounts.json"), "utf8");
    expect(file).not.toContain(np.password);
    expect(statSync(join(dir, "accounts.json")).mode & 0o077).toBe(0); // owner-only
    expect(acc.blocked(tenant, "pat@example.test")).toBe(false);
    acc.mark(tenant, "pat@example.test", { last_failure_at: Date.now(), last_failure_code: "invalid" });
    expect(acc.blocked(tenant, "pat@example.test")).toBe(true);
    await acc.forget(tenant, "pat@example.test");
    expect(await acc.password(tenant, "pat@example.test")).toBeNull();
    expect(acc.list()).toEqual([]);

    // Shared mode: no shared password saved → no new password (the user must set one first).
    mode = "shared";
    expect(await acc.newPassword()).toBeNull();
    await acc.setShared("Shared-Pass-1!");
    expect(await acc.newPassword()).toEqual({ password: "Shared-Pass-1!", mode: "shared" });
  });
});
