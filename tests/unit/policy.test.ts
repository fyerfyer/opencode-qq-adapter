import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { privateChat } from "../../src/domain/chat.js";
import type { IncomingMessage } from "../../src/domain/message.js";
import { PolicyEngine } from "../../src/policy/engine.js";

const config = configSchema.parse({
  version: 1,
  onebot: { url: "ws://127.0.0.1:3001", access_token: "token" },
  default_project: "blog",
  users: {
    "10001": { role: "owner", projects: ["*"] },
    "10002": { role: "member", projects: ["blog"] },
    "10003": { role: "member", projects: ["infra"] },
  },
  groups: {
    "20001": {
      enabled: true,
      mode: "per_user",
      allowed_users: ["10002"],
      projects: ["blog"],
    },
  },
  projects: {
    blog: { path: "/tmp/blog", allowed_users: ["10001", "10002"] },
    infra: { path: "/tmp/infra", allowed_users: ["10001", "10003"] },
  },
});

const policy = new PolicyEngine(config);

function actorFor(qq: number) {
  const actor = policy.actor(qq);
  if (actor === null) throw new Error(`missing test actor ${qq}`);
  return actor;
}

function message(userId: number, groupId?: number): IncomingMessage {
  return {
    id: "1",
    chat: groupId
      ? { type: "group", userId, groupId, chatKey: `group:${groupId}:${userId}` }
      : privateChat(userId),
    userId,
    senderName: "tester",
    text: "hi",
    images: [],
    mentionsBot: false,
    receivedAt: Date.now(),
    raw: {},
  };
}

describe("policy engine", () => {
  it("denies unknown users", () => {
    expect(policy.authorize(message(99999))).toMatchObject({
      allowed: false,
      reason: "unknown_user",
    });
  });

  it("lets owners use all projects", () => {
    const actor = actorFor(10001);
    expect(policy.availableProjects(actor, 10001).map((entry) => entry.id)).toEqual([
      "blog",
      "infra",
    ]);
  });

  it("restricts members to their assigned projects", () => {
    const actor = actorFor(10002);
    expect(policy.availableProjects(actor, 10002).map((entry) => entry.id)).toEqual(["blog"]);
    expect(policy.canUseProject(actor, 10002, "infra").allowed).toBe(false);
  });

  it("requires the user and project to be allowed in a group", () => {
    const denied = policy.authorize(message(10003, 20001));
    expect(denied).toMatchObject({ allowed: false, reason: "group_user_not_allowed" });
    const allowed = policy.authorize(message(10002, 20001));
    expect(allowed.allowed).toBe(true);
    const actor = actorFor(10002);
    expect(policy.canUseProject(actor, 10002, "blog", 20001).allowed).toBe(true);
    expect(policy.canUseProject(actor, 10002, "infra", 20001).allowed).toBe(false);
  });

  it("resolves the configured default project", () => {
    const actor = actorFor(10002);
    expect(policy.defaultProject(actor, 10002)?.id).toBe("blog");
    const infraActor = actorFor(10003);
    expect(policy.defaultProject(infraActor, 10003)?.id).toBe("infra");
  });
});
