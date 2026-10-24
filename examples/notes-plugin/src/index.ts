import { defineCommand, definePlugin } from "@opencode-qq/plugin-sdk";

interface NotesOptions {
  maxNotes: number;
  storageFile: string;
}

interface Note {
  id: number;
  text: string;
  author: string;
  qq: number;
  createdAt: number;
}

type NotesFile = Record<string, Note[]>;

function parseOptions(input: unknown): NotesOptions {
  const value =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const maxNotes =
    typeof value.maxNotes === "number" && Number.isInteger(value.maxNotes) && value.maxNotes > 0
      ? Math.min(value.maxNotes, 200)
      : 50;
  const storageFile =
    typeof value.storageFile === "string" && /^[A-Za-z0-9._-]+$/.test(value.storageFile)
      ? value.storageFile
      : "notes.json";
  return { maxNotes, storageFile };
}

export default definePlugin<NotesOptions>({
  options: { parse: parseOptions },
  setup(context) {
    let chain: Promise<unknown> = Promise.resolve();
    const withNotes = <T>(task: () => Promise<T>): Promise<T> => {
      const next = chain.then(task, task);
      chain = next.catch(() => undefined);
      return next;
    };

    const load = async (): Promise<NotesFile> =>
      (await context.storage.readJson<NotesFile>(context.config.storageFile)) ?? {};
    const save = (notes: NotesFile): Promise<void> =>
      context.storage.writeJson(context.config.storageFile, notes);

    context.commands.register(
      defineCommand({
        name: "note",
        aliases: ["notes"],
        description: "按会话记录笔记",
        usage: "note add <内容> | note list | note del <编号>",
        chats: ["private", "group"],
        handler: async (command) => {
          const sub = (command.args[0] ?? "").toLowerCase();
          const chatKey = command.message.chat.chatKey;

          if (sub === "add") {
            const text = command.rawArgs.slice("add".length).trim();
            if (text.length === 0) return "用法：!note add <内容>";
            if (text.length > 500) return "笔记最多 500 字。";
            return withNotes(async () => {
              const notes = await load();
              const list = notes[chatKey] ?? [];
              if (list.length >= context.config.maxNotes) {
                return `本会话笔记已满（上限 ${context.config.maxNotes} 条）。`;
              }
              const id = list.reduce((max, note) => Math.max(max, note.id), 0) + 1;
              list.push({
                id,
                text,
                author: command.message.senderName,
                qq: command.actor.qq,
                createdAt: Date.now(),
              });
              notes[chatKey] = list;
              await save(notes);
              return `已记录笔记 #${id}。`;
            });
          }

          if (sub === "list" || sub.length === 0) {
            return withNotes(async () => {
              const notes = (await load())[chatKey] ?? [];
              if (notes.length === 0) return "本会话还没有笔记。使用 !note add <内容> 添加。";
              const lines = [`本会话笔记（${notes.length}/${context.config.maxNotes}）：`];
              for (const note of notes.slice(-15)) {
                lines.push(`#${note.id} · ${note.author}：${note.text}`);
              }
              if (notes.length > 15) lines.push(`… 仅显示最近 15 条`);
              return lines.join("\n");
            });
          }

          if (sub === "del" || sub === "delete" || sub === "rm") {
            const id = Number(command.args[1]);
            if (!Number.isInteger(id) || id <= 0) return "用法：!note del <编号>";
            return withNotes(async () => {
              const notes = await load();
              const list = notes[chatKey] ?? [];
              const index = list.findIndex((note) => note.id === id);
              if (index < 0) return `找不到笔记 #${id}。`;
              list.splice(index, 1);
              notes[chatKey] = list;
              await save(notes);
              return `已删除笔记 #${id}。`;
            });
          }

          return "用法：!note add <内容> | !note list | !note del <编号>";
        },
      }),
    );
  },
});
