import {
  cancel,
  confirm as clackConfirm,
  select as clackSelect,
  isCancel,
  text,
} from "@clack/prompts";
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

/**
 * Clack-based interactive prompts. Non-interactive setup (`--yes`) never
 * constructs this object, so CI and scripted runs stay deterministic.
 */
export function createPrompt(): Prompt {
  return {
    async ask(question, defaultValue = "") {
      const value = await text({
        message: question,
        ...(defaultValue.length > 0 ? { placeholder: defaultValue, defaultValue } : {}),
      });
      if (isCancel(value)) {
        cancel("Setup cancelled.");
        throw new SetupError("cancelled", "Setup cancelled.");
      }
      const answer = value.trim();
      return answer.length > 0 ? answer : defaultValue;
    },
    async confirm(question, defaultValue) {
      const value = await clackConfirm({
        message: question,
        initialValue: defaultValue,
      });
      if (isCancel(value)) {
        cancel("Setup cancelled.");
        throw new SetupError("cancelled", "Setup cancelled.");
      }
      return value;
    },
    async select<T extends string>(
      question: string,
      options: Array<{ value: T; label: string }>,
      defaultIndex = 0,
    ) {
      if (options.length === 0) throw new SetupError("invalid", "No options available");
      const value = await clackSelect<string>({
        message: question,
        options: options.map((option) => ({
          value: String(option.value),
          label: option.label,
        })),
        initialValue: String(options[defaultIndex]?.value ?? options[0]?.value ?? ""),
      });
      if (isCancel(value)) {
        cancel("Setup cancelled.");
        throw new SetupError("cancelled", "Setup cancelled.");
      }
      return value as T;
    },
    close() {
      // Clack manages its own readline lifecycle.
    },
  };
}
