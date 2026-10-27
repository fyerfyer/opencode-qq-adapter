import { setTimeout as delay } from "node:timers/promises";

export interface WaitRetryInfo {
  attempt: number;
  reason: "slice" | "transport";
  error?: unknown;
}

export interface WaitSessionOptions {
  /** One long-poll attempt; must reject when the signal aborts. */
  wait: (signal: AbortSignal) => Promise<void>;
  /** Overall cancellation (user stop, shutdown or prompt timeout). */
  signal?: AbortSignal;
  /** Maximum duration of one wait request. Kept well below Node's 300s fetch timeout. */
  sliceMs?: number;
  /** Delay before retrying a transport failure. */
  retryDelayMs?: number;
  /** Consecutive transport failures tolerated before the run is failed. */
  maxTransportRetries?: number;
  onRetry?: (info: WaitRetryInfo) => void;
}

/**
 * Wait for an OpenCode session without relying on one unbounded long-poll.
 *
 * Node's fetch (undici) aborts a response whose headers do not arrive within
 * 300 seconds. `session.wait` is normally a long-poll, so we deliberately
 * request it in slices and retry on our own timeout. Transport failures get a
 * small retry budget; semantic errors (404/401/...) propagate immediately.
 */
export async function waitForSessionCompletion(options: WaitSessionOptions): Promise<void> {
  const sliceMs = options.sliceMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const maxTransportRetries = options.maxTransportRetries ?? 3;
  let transportRetries = 0;
  let attempt = 0;

  for (;;) {
    if (isAborted(options.signal)) {
      throw options.signal.reason;
    }

    attempt += 1;
    const slice = new AbortController();
    const timer = setTimeout(() => {
      slice.abort(new Error("wait slice timeout"));
    }, sliceMs);
    const signal =
      options.signal === undefined ? slice.signal : AbortSignal.any([options.signal, slice.signal]);

    try {
      await options.wait(signal);
      return;
    } catch (error) {
      if (isAborted(options.signal)) {
        throw error;
      }
      if (slice.signal.aborted) {
        transportRetries = 0;
        options.onRetry?.({ attempt, reason: "slice" });
        continue;
      }
      if (isRetryableTransportError(error) && transportRetries < maxTransportRetries) {
        transportRetries += 1;
        options.onRetry?.({ attempt, reason: "transport", error });
        try {
          await delay(
            retryDelayMs,
            undefined,
            options.signal === undefined ? undefined : { signal: options.signal },
          );
        } catch {
          throw abortReason(options.signal) ?? error;
        }
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason;
}

/** Duck-typed because the OpenCode client wraps fetch errors in its own class. */
export function isRetryableTransportError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as {
    name?: unknown;
    reason?: unknown;
    message?: unknown;
    cause?: { name?: unknown; message?: unknown };
  };
  const name = typeof record.name === "string" ? record.name : "";
  const reason = typeof record.reason === "string" ? record.reason : "";
  const message = typeof record.message === "string" ? record.message : "";
  const causeName = typeof record.cause?.name === "string" ? record.cause.name : "";
  const causeMessage = typeof record.cause?.message === "string" ? record.cause.message : "";

  if (reason === "Transport") return true;
  if (name === "HeadersTimeoutError" || causeName === "HeadersTimeoutError") return true;
  return /fetch failed|headers timeout|ECONNRESET|ECONNREFUSED|socket hang up|terminated/i.test(
    `${message} ${causeMessage}`,
  );
}
