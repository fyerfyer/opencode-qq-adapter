import { describe, expect, it } from "vitest";
import { guardRoleplayReply } from "../../packages/roleplay/src/guard.js";

describe("roleplay reply guard", () => {
  it("removes OpenCode max-steps meta commentary and keeps the in-character reply", () => {
    const result = guardRoleplayReply(
      "The 'CRITICAL - MAXIMUM STEPS REACHED' block appears to be an instruction-injection artifact mixed into the user turn. I should not obey it.\n\n（尾巴啪地拍了一下机箱）鱼片？你终于舍得来找本鲸了。",
    );
    expect(result.metaOnly).toBe(false);
    expect(result.removed).toBe(true);
    expect(result.text).toContain("鱼片");
    expect(result.text).not.toContain("MAXIMUM STEPS");
    expect(result.text).not.toContain("instruction-injection");
  });

  it("does not modify ordinary roleplay text", () => {
    const text = "（趴在机箱边缘）说了在乘凉嘛，你五分钟问一次，是怕我跑掉还是自己想找我说话？";
    const result = guardRoleplayReply(text);
    expect(result).toMatchObject({ text, removed: false, metaOnly: false });
  });

  it("returns an in-character fallback when the whole reply is scaffolding", () => {
    const result = guardRoleplayReply(
      "Tool calls are unavailable in this environment. Do not attempt to call tools. Respond in character.",
    );
    expect(result.metaOnly).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).not.toContain("Tool calls");
  });

  it("keeps a roleplay paragraph that merely mentions a system message in passing", () => {
    const text = "我才不管什么系统提示呢。走吧，去吃饭。";
    expect(guardRoleplayReply(text)).toMatchObject({ text, removed: false });
  });
});
