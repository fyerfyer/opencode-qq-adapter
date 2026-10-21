export type PermissionEffect = "allow" | "ask" | "deny";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export type PermissionRuleset = PermissionRule[];

/** OpenCode's reply values for a pending permission request. */
export type ApprovalDecision = "once" | "always" | "reject";

export interface AgentPermissionRequest {
  id: string;
  sessionId: string;
  action: string;
  resources: string[];
  save: string[];
  message: string | null;
  metadata: Record<string, unknown> | null;
}

/** Effects ordered from least to most restrictive. */
export const EFFECT_RANK: Record<PermissionEffect, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export function stricterEffect(
  left: PermissionEffect | undefined,
  right: PermissionEffect | undefined,
): PermissionEffect | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return EFFECT_RANK[left] >= EFFECT_RANK[right] ? left : right;
}
