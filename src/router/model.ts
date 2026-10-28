import type { AppConfig } from "../config/schema.js";
import type { ConversationRecord } from "../domain/conversation.js";
import type { AgentPort } from "../ports/agent.js";

export type ModelSource = "conversation" | "agent" | "project" | "opencode" | "none";

export interface EffectiveModel {
  model: string | null;
  source: ModelSource;
}

/**
 * Resolve the model a conversation will actually use.
 *
 * Explicit conversation overrides win. Otherwise the OpenCode agent's own
 * frontmatter model is authoritative, followed by project and OpenCode
 * defaults. `!model` previously stopped at the project/global default and
 * therefore reported "OpenCode 默认" even when qq-code.md specified a model.
 */
export async function resolveEffectiveModel(options: {
  agent: AgentPort;
  config: AppConfig;
  conversation: ConversationRecord | null;
  directory: string | null;
}): Promise<EffectiveModel> {
  const { agent, config, conversation, directory } = options;
  if (conversation?.model !== null && conversation?.model !== undefined) {
    return { model: conversation.model, source: "conversation" };
  }

  const project = conversation ? config.projects[conversation.projectId] : null;
  const agentId = conversation?.agent ?? project?.agent ?? config.opencode.default_agent ?? null;
  if (agentId !== null) {
    try {
      const agents = await agent.listAgents(directory ?? undefined);
      const found = agents.find((entry) => entry.id === agentId);
      if (found?.model !== null && found?.model !== undefined) {
        return { model: found.model, source: "agent" };
      }
    } catch {
      // Fall through to project/global defaults if the agent list is unavailable.
    }
  }

  if (project?.model !== null && project?.model !== undefined) {
    return { model: project.model, source: "project" };
  }
  if (config.opencode.default_model !== null) {
    return { model: config.opencode.default_model, source: "opencode" };
  }
  return { model: null, source: "none" };
}
