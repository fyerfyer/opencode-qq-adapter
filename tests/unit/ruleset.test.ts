import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../../src/domain/permission.js";
import { compilePermissionRuleset, permissionEffects } from "../../src/policy/ruleset.js";

function lastMatch(
  rules: PermissionRule[],
  action: string,
  resource: string,
): PermissionRule | null {
  let match: PermissionRule | null = null;
  for (const rule of rules) {
    if (matches(rule.action, action) && matches(rule.resource, resource)) match = rule;
  }
  return match;
}

function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

describe("compilePermissionRuleset", () => {
  it("allows read-only discovery without granting writes or commands", () => {
    const rules = compilePermissionRuleset({ writable: false });

    expect(lastMatch(rules, "read", "src/app.ts")?.effect).toBe("allow");
    expect(lastMatch(rules, "glob", "src/**")?.effect).toBe("allow");
    expect(lastMatch(rules, "grep", "TODO")?.effect).toBe("allow");
    expect(lastMatch(rules, "edit", "src/app.ts")?.effect).toBe("deny");
    expect(lastMatch(rules, "shell", "npm test")?.effect).toBe("deny");
    expect(lastMatch(rules, "execute", "*")?.effect).toBe("deny");
    expect(lastMatch(rules, "external_directory", "/etc")?.effect).toBe("deny");
    expect(lastMatch(rules, "subagent", "*")?.effect).toBe("deny");
  });

  it("allows edits and asks before shell commands for writable projects", () => {
    const rules = compilePermissionRuleset({ writable: true });

    expect(lastMatch(rules, "read", "src/app.ts")?.effect).toBe("allow");
    expect(lastMatch(rules, "edit", "src/app.ts")?.effect).toBe("allow");
    expect(lastMatch(rules, "shell", "npm test")?.effect).toBe("ask");
    expect(lastMatch(rules, "execute", "*")?.effect).toBe("allow");
    expect(lastMatch(rules, "external_directory", "/etc")?.effect).toBe("deny");
    expect(lastMatch(rules, "subagent", "*")?.effect).toBe("deny");
  });

  it("denies .env reads after the broad read allow rule", () => {
    const rules = compilePermissionRuleset({ writable: true });
    expect(lastMatch(rules, "read", ".env")?.effect).toBe("deny");
    expect(lastMatch(rules, "read", "config/.env.local")?.effect).toBe("deny");
    expect(lastMatch(rules, "read", "config/.env.example")?.effect).toBe("allow");
  });

  it("applies shell rules only when shell commands are available", () => {
    const writable = compilePermissionRuleset({
      writable: true,
      shellRules: [
        { pattern: "git status *", effect: "allow" },
        { pattern: "rm -rf *", effect: "deny" },
      ],
    });
    expect(lastMatch(writable, "shell", "git status --short")?.effect).toBe("allow");
    expect(lastMatch(writable, "shell", "rm -rf /tmp/x")?.effect).toBe("deny");

    const readonly = compilePermissionRuleset({
      writable: false,
      shellRules: [{ pattern: "git status *", effect: "allow" }],
    });
    expect(lastMatch(readonly, "shell", "git status")?.effect).toBe("deny");
  });

  it("exposes a compact effect summary for status output", () => {
    expect(permissionEffects({ writable: true })).toMatchObject({
      read: "allow",
      edit: "allow",
      shell: "ask",
      external_directory: "deny",
    });
    expect(permissionEffects({ writable: false })).toMatchObject({
      read: "allow",
      edit: "deny",
      shell: "deny",
      external_directory: "deny",
    });
  });
});
