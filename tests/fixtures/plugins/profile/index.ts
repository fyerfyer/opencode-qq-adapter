import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCommand, definePlugin } from "../../../../src/plugins/sdk.js";

interface ProfileOptions {
  directory: string;
}

export default definePlugin<ProfileOptions>({
  options: {
    parse(input) {
      const value =
        input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
      if (typeof value.directory !== "string" || value.directory.length === 0) {
        throw new Error("directory is required");
      }
      return { directory: value.directory };
    },
  },
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "fx-session",
        handler(command) {
          const chatKey = command.message.chat.chatKey;
          const switched = context.sessions.setProject(chatKey, "demo", command.actor);
          if (!switched.ok) return switched.reason ?? "setProject failed";
          const reset = context.sessions.reset(chatKey, command.actor);
          return reset.ok ? "session-ok" : (reset.reason ?? "reset failed");
        },
      }),
    );
    context.hooks.register({
      resolveConversationProfile({ projectId }) {
        if (projectId !== "demo") return undefined;
        return {
          directory: context.config.directory,
        };
      },
      formatReply({ text }) {
        if (text.length < 4) return undefined;
        return {
          segments: [{ text: text.slice(0, 3) }, { text: text.slice(3), delayMs: 5 }],
        };
      },
      async afterRun(run) {
        await writeFile(
          join(context.dataDir, "last-run.json"),
          JSON.stringify({ userText: run.userText, replyText: run.replyText }),
          "utf8",
        );
      },
    });
  },
});
