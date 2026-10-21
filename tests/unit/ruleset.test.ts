import { describe, expect, it } from "vitest";
import type { PermissionRule } from "../../src/domain/permission.js";
import { compilePermissionRuleset, effectivePolicyEffects } from "../../src/policy/ruleset.js";

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
  it("starts from a safe baseline with read allowed and external directories denied", () => {
    const rules = compilePermissionRuleset({});

    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "ask" });
    expect(lastMatch(rules, "read", "src/app.ts")?.effect).toBe("allow");
    expect(lastMatch(rules, "external_directory", "/etc/passwd")?.effect).toBe("deny");
    expect(lastMatch(rules, "shell", "npm test")?.effect).toBe("ask");
  });

  it("denies .env reads after the broad read allow rule", () => {
    const rules = compilePermissionRuleset({});
    expect(lastMatch(rules, "read", ".env")?.effect).toBe("deny");
    expect(lastMatch(rules, "read", "config/.env.local")?.effect).toBe("deny");
    expect(lastMatch(rules, "read", "config/.env.example")?.effect).toBe("allow");
  });

  it("combines project, group and user policies using the most restrictive effect", () => {
    const rules = compilePermissionRuleset({
      project: { shell: "ask", edit: "allow" },
      group: { shell: "allow", edit: "deny" },
      user: { shell: "deny", edit: "allow" },
    });
    expect(lastMatch(rules, "shell", "npm test")?.effect).toBe("deny");
    expect(lastMatch(rules, "edit", "src/app.ts")?.effect).toBe("deny");
  });

  it("puts shell rules last so specific deny rules win over broad allows", () => {
    const rules = compilePermissionRuleset({
      project: {
        shell: "allow",
        shell_rules: [
          { pattern: "git status *", effect: "allow" },
          { pattern: "rm -rf *", effect: "deny" },
        ],
      },
    });
    expect(lastMatch(rules, "shell", "git status --short")?.effect).toBe("allow");
    expect(lastMatch(rules, "shell", "rm -rf /tmp/x")?.effect).toBe("deny");
  });

  it("forces write-capable actions to deny in readonly groups", () => {
    const rules = compilePermissionRuleset({
      project: { edit: "allow", shell: "allow", external_directory: "allow" },
      groupMode: "readonly",
    });
    expect(lastMatch(rules, "edit", "src/app.ts")?.effect).toBe("deny");
    expect(lastMatch(rules, "write", "src/app.ts")?.effect).toBe("deny");
    expect(lastMatch(rules, "shell", "npm test")?.effect).toBe("deny");
    expect(lastMatch(rules, "external_directory", "/tmp")?.effect).toBe("deny");
    expect(lastMatch(rules, "read", "src/app.ts")?.effect).toBe("allow");
  });

  it("exposes a compact effect summary for status output", () => {
    const effects = effectivePolicyEffects({
      project: { shell: "ask", edit: "deny" },
      user: { shell: "allow" },
    });
    expect(effects.shell).toBe("ask");
    expect(effects.edit).toBe("deny");
  });
});
