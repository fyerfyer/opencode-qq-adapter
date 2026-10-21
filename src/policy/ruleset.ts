import type { PolicyConfig } from "../config/schema.js";
import type { GroupMode } from "../domain/chat.js";
import {
  EFFECT_RANK,
  type PermissionEffect,
  type PermissionRule,
  type PermissionRuleset,
  stricterEffect,
} from "../domain/permission.js";

export interface PolicyRuleSources {
  project?: PolicyConfig | undefined;
  group?: PolicyConfig | undefined;
  user?: PolicyConfig | undefined;
  groupMode?: GroupMode | undefined;
}

interface ShellRule {
  pattern: string;
  effect: PermissionEffect;
}

const POLICY_ACTIONS = [
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "shell",
  "webfetch",
  "websearch",
  "external_directory",
] as const;

type PolicyAction = (typeof POLICY_ACTIONS)[number];

const BASELINE_EFFECTS: Record<PolicyAction, PermissionEffect> = {
  read: "allow",
  glob: "allow",
  grep: "allow",
  edit: "ask",
  write: "ask",
  shell: "ask",
  webfetch: "ask",
  websearch: "ask",
  external_directory: "deny",
};

const WRITE_ACTIONS: readonly PolicyAction[] = ["edit", "write", "shell", "external_directory"];

/**
 * Resolve the effective effect per action. Policy sources are combined with
 * "most restrictive wins" semantics so a user-level policy can never loosen a
 * project or group restriction.
 */
export function effectivePolicyEffects(
  sources: PolicyRuleSources,
): Record<string, PermissionEffect> {
  const effects: Record<string, PermissionEffect> = { ...BASELINE_EFFECTS };
  const policies = [sources.project, sources.group, sources.user].filter(
    (policy): policy is PolicyConfig => policy !== undefined,
  );

  for (const action of POLICY_ACTIONS) {
    for (const policy of policies) {
      const current = effects[action] ?? BASELINE_EFFECTS[action];
      effects[action] = stricterEffect(current, policy[action]) ?? current;
    }
  }

  if (sources.groupMode === "readonly") {
    for (const action of WRITE_ACTIONS) effects[action] = "deny";
  }

  return effects;
}

/**
 * Compile YAML policy into a V2 permission ruleset.
 *
 * OpenCode evaluates rules in order and the last matching rule wins. The
 * baseline is deliberately explicit: read/search are allowed, external paths
 * and .env files are denied, and everything else asks unless a policy says
 * otherwise. Shell rules are appended last so narrow denies cannot be
 * accidentally relaxed by broad policy allows.
 */
export function compilePermissionRuleset(sources: PolicyRuleSources): PermissionRuleset {
  const rules: PermissionRule[] = [{ action: "*", resource: "*", effect: "ask" }];

  for (const action of POLICY_ACTIONS) {
    if (action === "external_directory") continue;
    rules.push({ action, resource: "*", effect: BASELINE_EFFECTS[action] });
  }
  rules.push({ action: "external_directory", resource: "*", effect: "deny" });

  const effects = effectivePolicyEffects(sources);
  for (const action of POLICY_ACTIONS) {
    const effect = effects[action];
    if (effect === undefined) continue;
    rules.push({ action, resource: "*", effect });
  }

  // Keep secret files protected even when policy allows reads broadly.
  rules.push(
    { action: "read", resource: ".env", effect: "deny" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "read", resource: ".env.example", effect: "allow" },
  );

  for (const rule of collectShellRules([sources.project, sources.group, sources.user])) {
    rules.push({ action: "shell", resource: rule.pattern, effect: rule.effect });
  }

  // Read-only groups must stay read-only even if a policy or shell rule says
  // otherwise. These rules intentionally come last.
  if (sources.groupMode === "readonly") {
    for (const action of WRITE_ACTIONS) {
      rules.push({ action, resource: "*", effect: "deny" });
    }
  }

  return dedupeRules(rules);
}

function collectShellRules(policies: Array<PolicyConfig | undefined>): ShellRule[] {
  const rules = policies.flatMap((policy) =>
    (policy?.shell_rules ?? []).map((rule) => ({
      pattern: rule.pattern,
      effect: rule.effect,
    })),
  );
  // Within the same specificity, deny must win over ask and allow. Because the
  // last matching rule wins, emit the least restrictive effects first.
  return rules.sort((a, b) => EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect]);
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
