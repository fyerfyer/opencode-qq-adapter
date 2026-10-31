import {
  formatGreeting,
  type GreetingOptions,
  normalizeGreetingOptions,
} from "@opencode-qq/example-greeting-kit";
import { defineCommand, definePlugin } from "@opencode-qq/plugin-sdk";

/**
 * Runtime Plugin: package.json has an `opencodeQq` manifest and the bridge
 * loads it through `PluginHost`. Reusable policy/formatting lives in the
 * imported library instead of a second plugin.
 */
export interface LibraryDemoOptions extends GreetingOptions {
  injectContext: boolean;
}

function parseOptions(input: unknown): LibraryDemoOptions {
  const value =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    ...normalizeGreetingOptions(value),
    injectContext: value.injectContext === true,
  };
}

export default definePlugin<LibraryDemoOptions>({
  options: { parse: parseOptions },
  setup(context) {
    context.commands.register(
      defineCommand({
        name: "greet",
        description: "使用共享 Library 生成问候",
        usage: "greet [名字]",
        chats: ["private", "group"],
        handler(command) {
          const name = command.args.join(" ").trim() || command.message.senderName;
          return formatGreeting(name, context.config);
        },
      }),
    );

    context.hooks.register({
      beforePrompt(prompt) {
        if (!context.config.injectContext) return undefined;
        return {
          append: `[library-demo] ${formatGreeting(prompt.message.senderName, context.config)}`,
        };
      },
    });
  },
});
