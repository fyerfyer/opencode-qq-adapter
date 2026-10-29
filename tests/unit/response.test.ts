import { describe, expect, it } from "vitest";
import { collectResponse } from "../../src/conversation/response.js";
import type { ActiveRun } from "../../src/conversation/types.js";
import { type MessageCostPricing, mapMessage } from "../../src/opencode/mappers.js";
import type { AgentMessage } from "../../src/ports/agent.js";
import { FakeAgent } from "../helpers/fakes.js";

function message(
  overrides: Partial<AgentMessage> & Pick<AgentMessage, "id" | "type">,
): AgentMessage {
  return {
    text: "",
    created: 1,
    error: null,
    cost: null,
    tokens: null,
    agent: null,
    model: null,
    ...overrides,
  };
}

function activeRun(): ActiveRun {
  return {
    record: {
      id: "run",
      chatKey: "private:1",
      projectId: "demo",
      workspaceId: null,
      sessionId: null,
      actorQq: 1,
      status: "running",
      startedAt: 1,
      finishedAt: null,
      stopReason: null,
      error: null,
      usageJson: null,
    },
    message: {
      id: "prompt",
      chat: { type: "private", userId: 1, chatKey: "private:1" },
      userId: 1,
      senderName: "tester",
      text: "hello",
      images: [],
      mentionsBot: false,
      receivedAt: 1,
      raw: {},
    },
    permissions: [],
    abort: new AbortController(),
    stopRequested: false,
    interrupted: false,
    agentError: null,
    partialText: "",
    usage: null,
    workspaceId: null,
    workspacePath: null,
  };
}

describe("final response extraction", () => {
  it("keeps only text after the last tool call in one assistant message", () => {
    const mapped = mapMessage({
      id: "msg",
      type: "assistant",
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "I will inspect the workspace." },
        { type: "tool" },
        { type: "text", text: "Here is the final answer." },
      ],
    });
    expect(mapped.text).toBe("Here is the final answer.");
  });

  it("computes a missing assistant cost from model pricing", () => {
    const mapped = mapMessage(
      {
        id: "msg",
        type: "assistant",
        cost: 0,
        model: { id: "deepseek-v4.1-flash", providerID: "opencode-go" },
        tokens: {
          input: 2130,
          output: 75,
          reasoning: 96,
          cache: { read: 145792, write: 0 },
        },
      },
      [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
    );
    expect(mapped.cost).toBeCloseTo(0.000859476, 12);
  });

  it("does not replace a cost reported by OpenCode", () => {
    const pricing: MessageCostPricing = {
      input: 1,
      output: 2,
      cache: { read: 3, write: 4 },
    };
    const mapped = mapMessage(
      {
        id: "msg",
        type: "assistant",
        cost: 0.123,
        tokens: {
          input: 1000,
          output: 100,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
      [pricing],
    );
    expect(mapped.cost).toBe(0.123);
  });

  it("bills reasoning tokens at the output price and selects the matching tier", () => {
    const pricing: MessageCostPricing[] = [
      { input: 1, output: 10, cache: { read: 0, write: 0 } },
      {
        tier: { type: "context", size: 100_000 },
        input: 2,
        output: 20,
        cache: { read: 0, write: 0 },
      },
    ];
    const mapped = mapMessage(
      {
        id: "msg",
        type: "assistant",
        cost: null,
        tokens: {
          input: 200_000,
          output: 100_000,
          reasoning: 100_000,
          cache: { read: 0, write: 0 },
        },
      },
      pricing,
    );
    expect(mapped.cost).toBeCloseTo(4.4, 12);
  });

  it("returns only the newest assistant text, not intermediate narration", async () => {
    const agent = new FakeAgent();
    const session = await agent.createSession({ directory: "/tmp" });
    agent.messages.set(session.id, [
      message({ id: "final", type: "assistant", text: "final answer", created: 3 }),
      message({ id: "middle", type: "assistant", text: "looking around", created: 2 }),
      message({ id: "prompt", type: "user", text: "hello", created: 1 }),
    ]);

    const result = await collectResponse(
      agent,
      session.id,
      { messageId: "prompt", created: 1 },
      activeRun(),
    );
    expect(result.text).toBe("final answer");
  });

  it("ignores an older interrupted step when the newest assistant message is clean", async () => {
    const agent = new FakeAgent();
    const session = await agent.createSession({ directory: "/tmp" });
    agent.messages.set(session.id, [
      message({ id: "latest", type: "assistant", text: "", created: 4 }),
      message({
        id: "old-error",
        type: "assistant",
        text: "",
        error: "aborted: Step interrupted",
        created: 3,
      }),
      message({ id: "prompt", type: "user", text: "hello", created: 1 }),
    ]);

    const result = await collectResponse(
      agent,
      session.id,
      { messageId: "prompt", created: 1 },
      activeRun(),
    );
    expect(result.error).toBeNull();
  });

  it("reports an error on the newest assistant message", async () => {
    const agent = new FakeAgent();
    const session = await agent.createSession({ directory: "/tmp" });
    agent.messages.set(session.id, [
      message({
        id: "latest",
        type: "assistant",
        text: "",
        error: "provider.transport: ECONNREFUSED",
        created: 4,
      }),
      message({ id: "prompt", type: "user", text: "hello", created: 1 }),
    ]);

    const result = await collectResponse(
      agent,
      session.id,
      { messageId: "prompt", created: 1 },
      activeRun(),
    );
    expect(result.error).toBe("provider.transport: ECONNREFUSED");
  });

  it("returns the agent and model used by the newest assistant message", async () => {
    const agent = new FakeAgent();
    const session = await agent.createSession({ directory: "/tmp" });
    agent.messages.set(session.id, [
      message({
        id: "latest",
        type: "assistant",
        text: "answer",
        agent: "qq-code",
        model: "opencode-go/deepseek-v4.1-flash",
        created: 4,
      }),
      message({ id: "prompt", type: "user", text: "hello", created: 1 }),
    ]);

    const result = await collectResponse(
      agent,
      session.id,
      { messageId: "prompt", created: 1 },
      activeRun(),
    );
    expect(result).toMatchObject({
      agent: "qq-code",
      model: "opencode-go/deepseek-v4.1-flash",
    });
  });
});
