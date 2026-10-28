import { describe, expect, it } from "vitest";
import type { ConversationRecord } from "../../src/domain/conversation.js";
import { resolveEffectiveModel } from "../../src/router/model.js";
import { FakeAgent, makeTestConfig } from "../helpers/fakes.js";

function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    chatKey: "private:20000",
    projectId: "demo",
    workspaceId: null,
    sessionId: null,
    actorQq: 20000,
    agent: "qq-code",
    model: null,
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  };
}

function agentWithQqCodeModel(): FakeAgent {
  const agent = new FakeAgent();
  agent.agents.push({
    id: "qq-code",
    name: "QQ Code",
    description: "Fake QQ coding agent",
    mode: "primary",
    model: "fake/model-a",
    hidden: false,
  });
  return agent;
}

describe("effective model resolution", () => {
  it("prefers an explicit conversation model", async () => {
    const agent = new FakeAgent();
    const config = makeTestConfig({ projectPath: "/tmp" });
    const result = await resolveEffectiveModel({
      agent,
      config,
      conversation: conversation({ model: "fake/model-b" }),
      directory: "/tmp",
    });
    expect(result).toEqual({ model: "fake/model-b", source: "conversation" });
  });

  it("falls back to the agent frontmatter model", async () => {
    const agent = agentWithQqCodeModel();
    const config = makeTestConfig({ projectPath: "/tmp" });
    const result = await resolveEffectiveModel({
      agent,
      config,
      conversation: conversation(),
      directory: "/tmp",
    });
    expect(result).toEqual({ model: "fake/model-a", source: "agent" });
  });

  it("falls back to the project and then OpenCode defaults", async () => {
    const agent = new FakeAgent();
    const config = makeTestConfig({ projectPath: "/tmp" });
    config.projects.demo.model = "fake/model-b";
    expect(
      await resolveEffectiveModel({
        agent,
        config,
        conversation: conversation({ agent: "build" }),
        directory: "/tmp",
      }),
    ).toEqual({ model: "fake/model-b", source: "project" });

    config.projects.demo.model = null;
    config.opencode.default_model = "fake/model-a";
    expect(
      await resolveEffectiveModel({
        agent,
        config,
        conversation: conversation({ agent: "build" }),
        directory: "/tmp",
      }),
    ).toEqual({ model: "fake/model-a", source: "opencode" });
  });

  it("returns none when no model is configured", async () => {
    const agent = new FakeAgent();
    const config = makeTestConfig({ projectPath: "/tmp" });
    const result = await resolveEffectiveModel({
      agent,
      config,
      conversation: conversation({ agent: "build" }),
      directory: "/tmp",
    });
    expect(result).toEqual({ model: null, source: "none" });
  });
});
