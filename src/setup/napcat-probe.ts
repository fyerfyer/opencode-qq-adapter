import WebSocket from "ws";

export type NapcatProbeCode = "ok" | "token_rejected" | "unavailable" | "invalid_url";

export interface NapcatProbeResult {
  ok: boolean;
  code?: NapcatProbeCode;
  error?: string;
}

/**
 * Verify the NapCat WebSocket endpoint and access token before setup writes
 * them to `.env`. NapCat appends the token as a query parameter, matching the
 * OneBot SDK used by the bridge.
 *
 * The probe is intentionally one-shot: it does not keep a connection open and
 * never includes the token in error messages.
 */
export async function probeNapcatWebSocket(
  url: string,
  token: string,
  timeoutMs = 5000,
): Promise<NapcatProbeResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, code: "invalid_url", error: "NapCat WebSocket URL is not valid." };
  }
  if (target.protocol !== "ws:" && target.protocol !== "wss:") {
    return {
      ok: false,
      code: "invalid_url",
      error: "NapCat WebSocket URL must start with ws:// or wss://.",
    };
  }
  target.search = "";
  target.hash = "";
  if (token.length > 0) target.searchParams.set("access_token", token);

  return await new Promise<NapcatProbeResult>((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const finish = (result: NapcatProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.terminate();
      } catch {
        // The socket may already be closed.
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: "unavailable",
        error: "Timed out while connecting to NapCat.",
      });
    }, timeoutMs);

    try {
      socket = new WebSocket(target.toString());
    } catch (error) {
      finish({
        ok: false,
        code: "unavailable",
        error: connectionError(errorMessage(error), token),
      });
      return;
    }

    socket.once("open", () => finish({ ok: true, code: "ok" }));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      const rejected = status === 401 || status === 403;
      finish({
        ok: false,
        code: rejected ? "token_rejected" : "unavailable",
        error: rejected
          ? `NapCat rejected the access token (HTTP ${status}).`
          : `NapCat WebSocket returned HTTP ${status}.`,
      });
    });
    socket.once("error", (error) => {
      finish({
        ok: false,
        code: "unavailable",
        error: connectionError(errorMessage(error), token),
      });
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function connectionError(message: string, token: string): string {
  const clean = redact(message, token);
  if (clean.includes("ECONNREFUSED")) {
    return "Cannot connect to NapCat; check the URL and that NapCat is running.";
  }
  if (/socket hang up/i.test(clean)) {
    return "NapCat closed the connection; it may be offline or not logged in.";
  }
  if (clean.includes("ENOTFOUND") || clean.includes("EAI_AGAIN")) {
    return "Cannot resolve the NapCat host.";
  }
  return `Could not connect to NapCat: ${clean}`;
}

function redact(message: string, token: string): string {
  if (token.length === 0) return message;
  return message.replaceAll(token, "<redacted>");
}
