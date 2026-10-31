import { type Logger, pino } from "pino";
import type { AppConfig } from "../config/schema.js";

const DEFAULT_REDACT = [
  "req.headers.authorization",
  "headers.authorization",
  "authorization",
  "access_token",
  "accessToken",
  "password",
  "token",
  "*.authorization",
  "*.access_token",
  "*.accessToken",
  "*.password",
  "*.token",
];

export function buildLogger(
  config: AppConfig,
  options: { env?: NodeJS.ProcessEnv; name?: string } = {},
): Logger {
  const env = options.env ?? process.env;
  const level = env.LOG_LEVEL ?? config.logging.level;
  const pretty =
    config.logging.pretty ??
    (env.LOG_PRETTY === "1" || (env.NODE_ENV !== "production" && process.stdout.isTTY === true));
  const extraRedact = config.logging.redact.flatMap((key) => [key, `*.${key}`]);

  return pino({
    name: options.name ?? "opencode-qq-adapter",
    level,
    base: {
      pid: process.pid,
      service: "opencode-qq-adapter",
    },
    redact: {
      paths: [...DEFAULT_REDACT, ...extraRedact],
      censor: "[redacted]",
    },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname,service",
              singleLine: false,
            },
          },
        }
      : {}),
  });
}
