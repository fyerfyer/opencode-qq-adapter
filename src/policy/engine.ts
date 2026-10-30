import { CHAT_PROJECT_ID, isChatProjectId } from "../chat/project.js";
import type { AppConfig, ProjectConfig, UserConfig } from "../config/schema.js";
import type { IncomingMessage } from "../domain/message.js";
import type { PermissionEffect, PermissionRuleset } from "../domain/permission.js";
import {
  chatPermissionEffects,
  compileChatPermissionRuleset,
  compilePermissionRuleset,
  permissionEffects,
} from "./ruleset.js";

export type DenyReason =
  | "unknown_user"
  | "project_not_allowed"
  | "project_not_found"
  | "hidden_project"
  | "default_project_missing";

export interface AccessDecision {
  allowed: boolean;
  actor: UserConfig | null;
  reason: DenyReason | null;
}

export interface ProjectEntry {
  id: string;
  project: ProjectConfig;
}

export interface PermissionDecision {
  ruleset: PermissionRuleset;
  effects: Record<string, PermissionEffect>;
  projectId: string;
  writable: boolean;
}

export interface ProjectOptions {
  /** Plugin-internal projects are only reachable through plugin session actions. */
  includeHidden?: boolean;
}

/**
 * User-centric authorization. Groups are deliberately not part of this model:
 * one QQ account has the same project permissions in private chats and groups.
 */
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

  authorize(message: IncomingMessage): AccessDecision {
    const actor = this.actor(message.userId);
    if (actor === null) {
      return { allowed: false, actor: null, reason: "unknown_user" };
    }
    return { allowed: true, actor, reason: null };
  }

  availableProjects(actor: UserConfig, options: ProjectOptions = {}): ProjectEntry[] {
    return Object.entries(this.#config.projects)
      .filter(([, project]) => options.includeHidden === true || !project.hidden)
      .filter(([id]) => matchesAny(actor.projects, id))
      .map(([id, project]) => ({ id, project }));
  }

  projectEntries(actor: UserConfig, options: ProjectOptions = {}): ProjectEntry[] {
    return this.availableProjects(actor, options);
  }

  /** The built-in project-less Q&A project, when enabled. */
  chatEntry(): ProjectEntry | null {
    if (!this.#config.chat.enabled) return null;
    const project = this.#config.projects[CHAT_PROJECT_ID];
    return project === undefined ? null : { id: CHAT_PROJECT_ID, project };
  }

  canUseProject(
    actor: UserConfig,
    projectId: string,
    options: ProjectOptions = {},
  ): { allowed: boolean; project: ProjectConfig | null; reason: DenyReason | null } {
    if (isChatProjectId(projectId)) {
      const chat = this.chatEntry();
      return chat === null
        ? { allowed: false, project: null, reason: "project_not_found" }
        : { allowed: true, project: chat.project, reason: null };
    }
    const project = Object.hasOwn(this.#config.projects, projectId)
      ? this.#config.projects[projectId]
      : undefined;
    if (project === undefined) {
      return { allowed: false, project: null, reason: "project_not_found" };
    }
    if (project.hidden) {
      if (options.includeHidden === true) {
        return { allowed: true, project, reason: null };
      }
      return { allowed: false, project: null, reason: "hidden_project" };
    }
    if (!matchesAny(actor.projects, projectId)) {
      return { allowed: false, project: null, reason: "project_not_allowed" };
    }
    return { allowed: true, project, reason: null };
  }

  canWriteProject(actor: UserConfig, projectId: string): boolean {
    if (isChatProjectId(projectId)) return false;
    const project = Object.hasOwn(this.#config.projects, projectId)
      ? this.#config.projects[projectId]
      : undefined;
    if (project === undefined || project.hidden) return false;
    if (!matchesAny(actor.projects, projectId)) return false;
    return matchesAny(actor.write_projects, projectId);
  }

  defaultProject(actor: UserConfig): ProjectEntry | null {
    const entries = this.availableProjects(actor);
    if (entries.length === 0) return this.chatEntry();
    const preferred = this.#config.default_project;
    if (preferred !== null && preferred !== undefined) {
      const found = entries.find((entry) => entry.id === preferred);
      if (found !== undefined) return found;
    }
    if (entries.length === 1) {
      return entries[0] ?? null;
    }
    return null;
  }

  isGroupMentionRequired(): boolean {
    return this.#config.security.require_mention_in_group;
  }

  /**
   * Resolve the final OpenCode permission ruleset for a user/project pair.
   * Hidden projects are allowed here because plugins (for example Roleplay)
   * switch to them internally; the plugin's agent still restricts its tools.
   */
  permissionsFor(message: IncomingMessage, projectId: string): PermissionDecision | null {
    const actor = this.actor(message.userId);
    if (actor === null) return null;
    if (isChatProjectId(projectId)) {
      const chat = this.chatEntry();
      if (chat === null) return null;
      const profile = { allowWeb: this.#config.chat.allow_web };
      return {
        ruleset: compileChatPermissionRuleset(profile),
        effects: chatPermissionEffects(profile),
        projectId,
        writable: false,
      };
    }
    const project = this.#config.projects[projectId];
    if (project === undefined) return null;
    const access = this.canUseProject(actor, projectId, { includeHidden: true });
    if (!access.allowed) return null;
    const writable = this.canWriteProject(actor, projectId);
    const profile = {
      writable,
      shellRules: this.#config.security.shell_rules,
    };
    return {
      ruleset: compilePermissionRuleset(profile),
      effects: permissionEffects(profile),
      projectId,
      writable,
    };
  }
}

function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.includes("*") || patterns.includes(value);
}
