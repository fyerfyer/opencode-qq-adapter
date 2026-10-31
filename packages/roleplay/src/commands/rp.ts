import { defineCommand, type PluginCommands } from "@opencode-qq/plugin-sdk";
import { getPersona } from "../persona.js";
import type { RoleplayRuntime } from "../runtime.js";

export function registerRpCommand(commands: PluginCommands, runtime: RoleplayRuntime): void {
  commands.register(
    defineCommand({
      name: "rp",
      description: "查看、开启或关闭角色扮演",
      usage: "rp [on|off|status]",
      chats: ["private", "group"],
      async handler(command) {
        const sub = command.args[0]?.toLowerCase() ?? "status";
        const chatKey = command.message.chat.chatKey;
        const binding = runtime.bindings.get(chatKey);

        if (sub === "status") {
          if (binding === null) return "角色扮演未配置。发送 !persona list 查看角色卡。";
          const persona = await getPersona(runtime.personasDir, binding.namespace);
          const conversation = runtime.sessions.get(chatKey) ?? command.conversation;
          return [
            `状态：${binding.enabled ? "开启" : "关闭"}`,
            `角色：${persona?.name ?? binding.namespace}`,
            `项目：${runtime.options.projectId}`,
            `会话：${conversation?.sessionId ?? "尚未创建"}`,
          ].join("\n");
        }

        if (sub === "off") {
          if (binding === null) return "当前没有绑定角色。";
          runtime.bindings.set({ ...binding, enabled: false, updatedAt: Date.now() });
          const restoreTo = binding.previousProjectId ?? runtime.options.fallbackProject;
          if (restoreTo === null) {
            runtime.sessions.reset(chatKey, command.actor);
            return "角色扮演已关闭。当前没有可恢复的项目，请发送 !use 项目 选择 coding 项目。";
          }
          const restored = runtime.sessions.setProject(chatKey, restoreTo, command.actor);
          if (!restored.ok) {
            return `已关闭角色扮演，但恢复原项目失败：${restored.reason ?? "未知原因"}`;
          }
          runtime.sessions.reset(chatKey, command.actor);
          return "角色扮演已关闭。下次发送 !persona use 角色ID 可以重新开启。";
        }

        if (sub === "on") {
          if (binding === null) {
            if (runtime.options.defaultPersona === null) {
              return "请先发送 !persona use 角色ID 选择角色。";
            }
            const fallback = await getPersona(runtime.personasDir, runtime.options.defaultPersona);
            if (fallback === null) {
              return `默认角色卡不存在：${runtime.options.defaultPersona}`;
            }
            return await runtime.activate(command, fallback, true);
          }
          const persona = await getPersona(runtime.personasDir, binding.namespace);
          if (persona === null) return `角色卡已丢失：${binding.namespace}`;
          return await runtime.activate(command, persona, true);
        }
        return "用法：!rp on | !rp off | !rp status";
      },
    }),
  );
}
