/**
 * A Library / Plugin Kit has no `opencodeQq` manifest and is never loaded by
 * `PluginHost`. Runtime plugins import it like any other npm package.
 */
export interface GreetingOptions {
  greeting?: string;
  punctuation?: string;
}

export function normalizeGreetingOptions(input: unknown): Required<GreetingOptions> {
  const value =
    input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    greeting:
      typeof value.greeting === "string" && value.greeting.trim().length > 0
        ? value.greeting.trim()
        : "你好",
    punctuation:
      typeof value.punctuation === "string" && value.punctuation.length > 0
        ? value.punctuation
        : "！",
  };
}

export function formatGreeting(name: string, options: GreetingOptions = {}): string {
  const normalized = normalizeGreetingOptions(options);
  const target = name.trim().length > 0 ? name.trim() : "朋友";
  return `${normalized.greeting}，${target}${normalized.punctuation}`;
}
