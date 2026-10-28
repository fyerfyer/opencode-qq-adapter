import { describe, expect, it } from "vitest";
import { applyAgentEvent } from "../../src/conversation/events.js";
import type { ActiveRun } from "../../src/conversation/types.js";

function activeRun(): ActiveRun {
  return {
    record: {
      id: "run",
      chatKey: "private:1",
      projectId: "demo",
      workspaceId: null,
      sessionId: "ses_1",
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

function event(type: string, data: unknown = {}) {
  return { type, sessionId: "ses_1", data, receivedAt: Date.now() };
}

describe("conversation agent events", () => {
  it("clears a failed execution error when a new execution starts", () => {
    const active = activeRun();
    applyAgentEvent(
      active,
      event("session.execution.failed", {
        error: { type: "aborted", message: "Step interrupted" },
      }),
    );
    expect(active.agentError).toBe("aborted: Step interrupted");

    applyAgentEvent(active, event("session.execution.started"));
    expect(active.agentError).toBeNull();
  });

  it("clears a failed execution error after a later execution succeeds", () => {
    const active = activeRun();
    applyAgentEvent(
      active,
      event("session.execution.failed", {
        error: { type: "aborted", message: "Step interrupted" },
      }),
    );

    applyAgentEvent(active, event("session.execution.succeeded"));
    expect(active.agentError).toBeNull();
  });

  it("keeps a final failure until the run is evaluated", () => {
    const active = activeRun();
    applyAgentEvent(
      active,
      event("session.execution.failed", {
        error: { type: "provider.transport", message: "ECONNREFUSED" },
      }),
    );

    applyAgentEvent(active, event("session.idle"));
    expect(active.agentError).toBe("provider.transport: ECONNREFUSED");
  });

  it("captures the agent and model from a step event", () => {
    const active = activeRun();
    applyAgentEvent(
      active,
      event("session.step.started", {
        agent: "qq-code",
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      }),
    );

    expect(active.agentName).toBe("qq-code");
    expect(active.modelRef).toBe("opencode-go/deepseek-v4.1-flash");
  });
});
