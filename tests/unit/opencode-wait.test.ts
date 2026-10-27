import { describe, expect, it, vi } from "vitest";
import { waitForSessionCompletion } from "../../src/opencode/wait.js";

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("waitForSessionCompletion", () => {
  it("retries after a bounded wait slice times out", async () => {
    const wait = vi.fn(async (signal: AbortSignal) => {
      if (wait.mock.calls.length < 3) await waitForAbort(signal);
    });

    await waitForSessionCompletion({ wait, sliceMs: 5, retryDelayMs: 1 });

    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("stops immediately when the overall signal is aborted", async () => {
    const controller = new AbortController();
    const wait = vi.fn((signal: AbortSignal) => waitForAbort(signal));

    const result = waitForSessionCompletion({
      wait,
      signal: controller.signal,
      sliceMs: 1_000,
      retryDelayMs: 1,
    });
    setTimeout(() => controller.abort(new Error("stop requested")), 5);

    await expect(result).rejects.toThrow("stop requested");
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("retries transient transport errors", async () => {
    let calls = 0;
    const wait = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        throw Object.assign(new Error("fetch failed"), { reason: "Transport" });
      }
    });

    await waitForSessionCompletion({ wait, sliceMs: 1_000, retryDelayMs: 1 });

    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("propagates non-transport errors without retrying", async () => {
    const error = Object.assign(new Error("session not found"), {
      reason: "UnexpectedStatus",
    });
    const wait = vi.fn(async () => {
      throw error;
    });

    await expect(waitForSessionCompletion({ wait, sliceMs: 1_000, retryDelayMs: 1 })).rejects.toBe(
      error,
    );
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("stops retrying transport errors after the retry budget", async () => {
    const error = Object.assign(new Error("Headers Timeout Error"), {
      reason: "Transport",
    });
    const wait = vi.fn(async () => {
      throw error;
    });

    await expect(
      waitForSessionCompletion({
        wait,
        sliceMs: 1_000,
        retryDelayMs: 1,
        maxTransportRetries: 2,
      }),
    ).rejects.toBe(error);
    expect(wait).toHaveBeenCalledTimes(3);
  });
});
