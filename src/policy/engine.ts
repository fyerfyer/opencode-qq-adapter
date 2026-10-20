import type { AppConfig, GroupConfig, ProjectConfig, UserConfig } from "../config/schema.js";
import type { GroupMode } from "../domain/chat.js";
import type { IncomingMessage } from "../domain/message.js";

export type DenyReason =
  | "unknown_user"
  | "group_disabled"
  | "group_user_not_allowed"
  | "project_not_allowed"
  | "project_not_found"
  | "default_project_missing";

export interface AccessDecision {
  allowed: boolean;
  actor: UserConfig | null;
  group: GroupConfig | null;
  reason: DenyReason | null;
}

export interface ProjectEntry {
  id: string;
  project: ProjectConfig;
}

export class PolicyEngine {
  readonly #config: AppConfig;

  constructor(config: AppConfig) {
    this.#config = config;
  }

  get config(): AppConfig {
    return this.#config;
  }

  actor(qq: number): UserConfig | null {
    return this.#config.users[String(qq)] ?? null;
  }

  group(groupId: number | undefined): GroupConfig | null {
    if (groupId === undefined) return null;
    return this.#config.groups[String(groupId)] ?? null;
  }

  groupMode(groupId: number): GroupMode {
    return this.group(groupId)?.mode ?? "per_user";
  }

  authorize(message: IncomingMessage): AccessDecision {
    const actor = this.actor(message.userId);
    if (actor === null) {
      return { allowed: false, actor: null, group: null, reason: "unknown_user" };
    }

    if (message.chat.type === "group") {
      const group = this.group(message.chat.groupId);
      if (group === null || !group.enabled) {
        return { allowed: false, actor, group, reason: "group_disabled" };
      }
      if (!group.allowed_users.includes(String(message.userId))) {
        return { allowed: false, actor, group, reason: "group_user_not_allowed" };
      }
      return { allowed: true, actor, group, reason: null };
    }

    return { allowed: true, actor, group: null, reason: null };
  }

  availableProjects(actor: UserConfig, qq: number, groupId?: number): ProjectEntry[] {
    return Object.entries(this.#config.projects)
      .filter(([id, project]) => this.#projectAllowed(actor, qq, id, project, groupId))
      .map(([id, project]) => ({ id, project }));
  }

  projectEntries(actor: UserConfig, qq: number, groupId?: number): ProjectEntry[] {
    return this.availableProjects(actor, qq, groupId);
  }

  canUseProject(
    actor: UserConfig,
    qq: number,
    projectId: string,
    groupId?: number,
  ): { allowed: boolean; project: ProjectConfig | null; reason: DenyReason | null } {
    const project = this.#config.projects[projectId];
    if (project === undefined) {
      return { allowed: false, project: null, reason: "project_not_found" };
    }
    if (!this.#projectAllowed(actor, qq, projectId, project, groupId)) {
      return { allowed: false, project: null, reason: "project_not_allowed" };
    }
    return { allowed: true, project, reason: null };
  }

  defaultProject(actor: UserConfig, qq: number, groupId?: number): ProjectEntry | null {
    const entries = this.availableProjects(actor, qq, groupId);
    if (entries.length === 0) return null;
    const group = this.group(groupId);
    const preferred = group?.default_project ?? this.#config.default_project;
    if (preferred !== null && preferred !== undefined) {
      const found = entries.find((entry) => entry.id === preferred);
      if (found !== undefined) return found;
    }
    if (entries.length === 1) {
      return entries[0] ?? null;
    }
    return null;
  }

  isGroupMentionRequired(groupId: number | undefined): boolean {
    if (groupId === undefined) return false;
    const group = this.group(groupId);
    return group?.require_mention ?? this.#config.security.require_mention_in_group;
  }

  projectPolicy(projectId: string): string {
    return this.#config.projects[projectId]?.policy ?? "standard";
  }

  #projectAllowed(
    actor: UserConfig,
    qq: number,
    projectId: string,
    project: ProjectConfig,
    groupId?: number,
  ): boolean {
    if (groupId !== undefined) {
      const group = this.group(groupId);
      if (group === null || !group.enabled) return false;
      if (!matchesAny(group.projects, projectId)) return false;
      if (
        project.allowed_groups !== undefined &&
        !project.allowed_groups.includes(String(groupId))
      ) {
        return false;
      }
    }
    if (actor.role === "owner") return true;
    if (!matchesAny(actor.projects, projectId)) return false;
    if (project.allowed_users !== undefined && !project.allowed_users.includes(String(qq))) {
      return false;
    }
    return true;
  }
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.includes("*") || patterns.includes(value);
}
