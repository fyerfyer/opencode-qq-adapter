import { createInterface, type Interface } from "node:readline/promises";
import { SetupError } from "./files.js";

export interface Prompt {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(
    question: string,
    options: Array<{ value: T; label: string }>,
    defaultIndex?: number,
  ): Promise<T>;
  close(): void;
}

export function createPrompt(): Prompt {
  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  let closed = false;

  return {
    async ask(question, defaultValue = "") {
      const suffix = defaultValue.length > 0 ? ` [${defaultValue}]` : "";
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer.length > 0 ? answer : defaultValue;
    },
    async confirm(question, defaultValue) {
      const hint = defaultValue ? "Y/n" : "y/N";
      const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
      if (answer.length === 0) return defaultValue;
      if (["y", "yes", "是", "1"].includes(answer)) return true;
      if (["n", "no", "否", "0"].includes(answer)) return false;
      throw new SetupError("invalid", `Please answer yes or no, got: ${answer}`);
    },
    async select(question, options, defaultIndex = 0) {
      if (options.length === 0) throw new SetupError("invalid", "No options available");
      const lines = options.map(
        (option, index) =>
          `  ${index + 1}) ${option.label}${index === defaultIndex ? " (default)" : ""}`,
      );
      const answer = (
        await rl.question(`${question}\n${lines.join("\n")}\nSelect [${defaultIndex + 1}]: `)
      ).trim();
      const index = answer.length === 0 ? defaultIndex : Number(answer) - 1;
      const selected = options[index];
      if (selected === undefined) {
        throw new SetupError("invalid", `Invalid selection: ${answer}`);
      }
      return selected.value;
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}
