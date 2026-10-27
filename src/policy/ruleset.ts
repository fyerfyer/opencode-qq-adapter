import type { ShellRuleConfig } from "../config/schema.js";
import {
  EFFECT_RANK,
  type PermissionEffect,
  type PermissionRule,
  type PermissionRuleset,
} from "../domain/permission.js";

export interface PermissionProfile {
  /** True when the actor may modify this project. */
  writable: boolean;
  /** Optional shell allow/deny refinements; only applied to writable projects. */
  shellRules?: readonly ShellRuleConfig[];
}

export interface ChatPermissionProfile {
  /** Allow read-only web search/fetch in project-less Q&A. */
  allowWeb: boolean;
}

const DISCOVERY_ACTIONS = ["read", "glob", "grep"] as const;

/**
 * Build the effective effects for one user/project pair. There is no longer a
 * project/group/user policy merge: a project is either writable or read-only.
 */
export function permissionEffects(profile: PermissionProfile): Record<string, PermissionEffect> {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    edit: profile.writable ? "allow" : "deny",
    shell: profile.writable ? "ask" : "deny",
    webfetch: "allow",
    websearch: "allow",
    question: "deny",
    external_directory: "deny",
    subagent: "deny",
    execute: profile.writable ? "allow" : "deny",
  };
}

/**
 * Compile one user/project permission profile into an OpenCode V2 ruleset.
 *
 * Read-only projects deny every mutating action directly (no approval prompt).
 * Writable projects allow edits and ask before shell commands; shell rules can
 * narrow that further (for example deny `sudo *` or allow `git status *`).
 *
 * Rules are ordered broad-to-specific because OpenCode uses the last matching
 * rule. `.env` and external-directory denies intentionally stay at the end.
 */
export function compilePermissionRuleset(profile: PermissionProfile): PermissionRuleset {
  const rules: PermissionRule[] = [];

  if (profile.writable) {
    // Unknown tools (for example MCP tools) ask instead of silently failing.
    rules.push({ action: "*", resource: "*", effect: "ask" });
  } else {
    rules.push({ action: "*", resource: "*", effect: "deny" });
  }

  for (const action of DISCOVERY_ACTIONS) {
    rules.push({ action, resource: "*", effect: "allow" });
  }
  for (const action of ["webfetch", "websearch", "skill"] as const) {
    rules.push({ action, resource: "*", effect: "allow" });
  }

  rules.push({
    action: "edit",
    resource: "*",
    effect: profile.writable ? "allow" : "deny",
  });
  rules.push({
    action: "shell",
    resource: "*",
    effect: profile.writable ? "ask" : "deny",
  });
  rules.push({
    action: "execute",
    resource: "*",
    effect: profile.writable ? "allow" : "deny",
  });
  rules.push({ action: "external_directory", resource: "*", effect: "deny" });
  // QQ has no interactive form UI, so the question tool would block the
  // session forever. The agent must ask in plain text instead.
  rules.push({ action: "question", resource: "*", effect: "deny" });
  // Subagents can carry their own, broader ruleset, so never let a QQ user
  // launch one as a permission bypass.
  rules.push({ action: "subagent", resource: "*", effect: "deny" });

  // Keep secret files protected even when reads are broadly allowed.
  rules.push(
    { action: "read", resource: ".env", effect: "deny" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "read", resource: ".env.example", effect: "allow" },
  );

  if (profile.writable) {
    for (const rule of sortShellRules(profile.shellRules ?? [])) {
      rules.push({ action: "shell", resource: rule.pattern, effect: rule.effect });
    }
  }

  return dedupeRules(rules);
}

/**
 * Compile the ruleset for the built-in project-less Q&A mode.
 *
 * The session runs in a dedicated empty directory. Reads inside that directory
 * are harmless and let the agent load its AGENTS.md, but every mutating action
 * and every tool that could reach outside the workspace stays denied.
 */
export function compileChatPermissionRuleset(profile: ChatPermissionProfile): PermissionRuleset {
  const rules: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];
  for (const action of DISCOVERY_ACTIONS) {
    rules.push({ action, resource: "*", effect: "allow" });
  }
  if (profile.allowWeb) {
    for (const action of ["webfetch", "websearch"] as const) {
      rules.push({ action, resource: "*", effect: "allow" });
    }
  }
  rules.push(
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "execute", resource: "*", effect: "deny" },
    { action: "read", resource: ".env", effect: "deny" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "read", resource: ".env.example", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "question", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  );
  return rules;
}

export function chatPermissionEffects(
  profile: ChatPermissionProfile,
): Record<string, PermissionEffect> {
  return {
    read: "allow",
    glob: "allow",
    grep: "allow",
    edit: "deny",
    shell: "deny",
    execute: "deny",
    webfetch: profile.allowWeb ? "allow" : "deny",
    websearch: profile.allowWeb ? "allow" : "deny",
    question: "deny",
    external_directory: "deny",
    subagent: "deny",
  };
}

function sortShellRules(rules: readonly ShellRuleConfig[]): ShellRuleConfig[] {
  // Because the last matching rule wins, emit the least restrictive effects
  // first so a specific deny can override a broad allow.
  return [...rules].sort((a, b) => EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect]);
}

function dedupeRules(rules: PermissionRuleset): PermissionRuleset {
  const seen = new Set<string>();
  const result: PermissionRuleset = [];
  // Keep the last occurrence: rule order is semantically significant.
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule === undefined) continue;
    const key = `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rule);
  }
  return result.reverse();
}
