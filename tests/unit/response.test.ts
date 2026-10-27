import { describe, expect, it } from "vitest";
import { collectResponse } from "../../src/conversation/response.js";
import type { ActiveRun } from "../../src/conversation/types.js";
import { mapMessage } from "../../src/opencode/mappers.js";
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
});
