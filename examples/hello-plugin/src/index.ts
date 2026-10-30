import { defineCommand, definePlugin } from "@opencode-qq/plugin-sdk";

export interface HelloOptions {
  greeting: string;
  injectContext: boolean;
}

function parseOptions(input: unknown): HelloOptions {
  const value =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    greeting:
      typeof value.greeting === "string" && value.greeting.length > 0 ? value.greeting : "你好",
    injectContext: value.injectContext === true,
  };
}

export default definePlugin<HelloOptions>({
  options: { parse: parseOptions },
  setup(context) {
    const logger = context.logger;

    context.commands.register(
      defineCommand({
        name: "hello",
        description: "插件连通性示例",
        usage: "hello [名字]",
        chats: ["private", "group"],
        async handler(command) {
          const name = command.args.join(" ").trim() || command.message.senderName;
          logger.info({ qq: command.actor.qq }, "hello command invoked");
          return `${context.config.greeting}，${name}！插件 SDK 工作正常。`;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "echo",
        description: "原样返回文本",
        usage: "echo <文本>",
        chats: ["private", "group"],
        handler(command) {
          if (command.rawArgs.length === 0) return "用法：!echo <文本>";
          return command.rawArgs;
        },
      }),
    );

    context.commands.register(
      defineCommand({
        name: "hello-info",
        description: "查看插件配置与数据目录",
        usage: "hello-info",
        chats: ["private"],
        roles: ["owner", "admin"],
        handler(command) {
          logger.info({ dataDir: context.dataDir }, "hello-info invoked");
          const conversation =
            context.sessions.get(command.message.chat.chatKey) ?? command.conversation;
          const session =
            conversation === null
              ? "未选择项目"
              : `${conversation.projectId} / ${conversation.sessionId ?? "尚未创建会话"}`;
          return [
            "hello 插件",
            `配置：greeting=${context.config.greeting}, injectContext=${context.config.injectContext}`,
            `会话：${session}`,
            `数据目录：${context.dataDir}`,
          ].join("\n");
        },
      }),
    );

    context.hooks.register({
      beforePrompt(prompt) {
        if (!context.config.injectContext) return undefined;
        return {
          append: `[hello-plugin] 当前 QQ 用户是 ${prompt.message.senderName}，项目是 ${prompt.projectId}。`,
        };
      },
      afterRun(run) {
        logger.info(
          {
            runId: run.runId,
            status: run.status,
            durationMs: run.durationMs,
            cost: run.usage?.cost ?? 0,
          },
          "hello plugin observed a finished run",
        );
      },
      onConfigReload(reload) {
        logger.info({ applied: reload.applied }, "hello plugin observed config reload");
      },
    });
  },
});
