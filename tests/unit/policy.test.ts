import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { privateChat } from "../../src/domain/chat.js";
import type { IncomingMessage } from "../../src/domain/message.js";
import { PolicyEngine } from "../../src/policy/engine.js";

const config = configSchema.parse({
  version: 2,
  onebot: { url: "ws://127.0.0.1:3001", access_token: "token" },
  default_project: "blog",
  users: {
    "10001": { role: "owner", projects: ["*"], write_projects: ["*"] },
    "10002": { role: "member", projects: ["blog", "infra"], write_projects: ["blog"] },
    "10003": { role: "member", projects: ["blog"], write_projects: [] },
  },
  projects: {
    blog: { path: "/tmp/blog" },
    infra: { path: "/tmp/infra" },
    roleplay: { path: "/tmp/roleplay", workspace: "none", hidden: true, managed_by: "roleplay" },
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

  it("allows configured users in private chats and in any group without group config", () => {
    expect(policy.authorize(message(10002)).allowed).toBe(true);
    expect(policy.authorize(message(10002, 77777)).allowed).toBe(true);
  });

  it("restricts users to their accessible projects and hides internal projects", () => {
    const actor = actorFor(10002);
    expect(policy.availableProjects(actor).map((entry) => entry.id)).toEqual(["blog", "infra"]);
    expect(policy.canUseProject(actor, "roleplay").allowed).toBe(false);
    expect(policy.canUseProject(actor, "roleplay").reason).toBe("hidden_project");
    expect(policy.canUseProject(actor, "roleplay", { includeHidden: true }).allowed).toBe(true);
  });

  it("does not resolve inherited object properties as projects", () => {
    const owner = actorFor(10001);
    expect(policy.canUseProject(owner, "toString")).toMatchObject({
      allowed: false,
      reason: "project_not_found",
    });
    expect(policy.canWriteProject(owner, "constructor")).toBe(false);
  });

  it("uses write_projects as the writable allowlist", () => {
    const writer = actorFor(10002);
    const reader = actorFor(10003);
    expect(policy.canWriteProject(writer, "blog")).toBe(true);
    expect(policy.canWriteProject(writer, "infra")).toBe(false);
    expect(policy.canWriteProject(reader, "blog")).toBe(false);
    expect(policy.canWriteProject(actorFor(10001), "roleplay")).toBe(false);
  });

  it("resolves the configured default project only when it is visible", () => {
    expect(policy.defaultProject(actorFor(10002))?.id).toBe("blog");
    expect(policy.defaultProject(actorFor(10003))?.id).toBe("blog");

    const hiddenDefault = configSchema.parse({
      ...config,
      default_project: "roleplay",
    });
    expect(new PolicyEngine(hiddenDefault).defaultProject(actorFor(10002))).toBeNull();
  });

  it("requires a mention in groups according to the global switch", () => {
    expect(policy.isGroupMentionRequired()).toBe(config.security.require_mention_in_group);
  });

  it("compiles a writable project to edit allow and shell ask", () => {
    const decision = policy.permissionsFor(message(10002), "blog");
    expect(decision).not.toBeNull();
    expect(decision?.writable).toBe(true);
    expect(decision?.effects.read).toBe("allow");
    expect(decision?.effects.edit).toBe("allow");
    expect(decision?.effects.shell).toBe("ask");
    expect(decision?.effects.external_directory).toBe("deny");
  });

  it("compiles a non-writable project to write denial without an approval prompt", () => {
    const decision = policy.permissionsFor(message(10002), "infra");
    expect(decision).not.toBeNull();
    expect(decision?.writable).toBe(false);
    expect(decision?.effects.edit).toBe("deny");
    expect(decision?.effects.shell).toBe("deny");
    expect(decision?.effects.read).toBe("allow");
  });

  it("returns null for projects the user cannot access", () => {
    expect(policy.permissionsFor(message(10003), "infra")).toBeNull();
  });
});
