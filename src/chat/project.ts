import { dirname, join } from "node:path";
import type { AppConfig } from "../config/schema.js";

/** Reserved internal project id for project-less Q&A. */
export const CHAT_PROJECT_ID = "@chat";

export function isChatProjectId(projectId: string): boolean {
  return projectId === CHAT_PROJECT_ID;
}

/**
 * Materialize the built-in @chat project after storage paths have been
 * resolved. Keeping it in the project map lets the existing session,
 * workspace, audit and quota code paths work without nullable project IDs.
 */
export function materializeChatProject(config: AppConfig): void {
  if (!config.chat.enabled) return;
  const path = config.chat.path ?? join(dirname(config.storage.database_path), "chat");
  config.chat.path = path;
  config.projects[CHAT_PROJECT_ID] = {
    path,
    description: "Project-less Q&A (read-only)",
    workspace: "none",
    agent: config.chat.agent ?? config.opencode.default_agent,
    model: config.chat.model ?? config.opencode.default_model,
    hidden: true,
    managed_by: "core",
  };
}
