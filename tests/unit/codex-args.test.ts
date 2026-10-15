// The Codex CLI call used for AI decisions: the model gets no tools (no shell, code execution,
// browsing, apps or web search), a read-only sandbox, no user config and no saved session.
import { describe, expect, it } from "vitest";
import { execArgs } from "../../src/local/codex";

describe("codex exec arguments", () => {
  it("switch off every tool and keep the sandbox read-only", () => {
    const a = execArgs("/tmp/s.json", "/tmp/o.json", "prompt");
    const joined = a.join(" ");
    for (const f of ["shell_tool", "unified_exec", "browser_use", "computer_use", "apps", "js_repl"]) expect(joined).toContain(`features.${f}=false`);
    expect(joined).toContain('web_search="disabled"');
    expect(a.slice(a.indexOf("--sandbox"), a.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
    expect(a).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--output-schema"]));
    expect(joined).not.toMatch(/dangerously|bypass|full-auto|danger-full-access|workspace-write/);
    expect(a[a.length - 1]).toBe("prompt");
  });
});
