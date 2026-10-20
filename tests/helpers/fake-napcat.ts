import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

interface OneBotAction {
  action: string;
  params: Record<string, unknown>;
  echo: string;
}

interface OneBotActionRecord {
  action: string;
  params: Record<string, unknown>;
  response: unknown;
}

export class FakeNapCatServer {
  #httpServer: Server | null = null;
  #wss: WebSocketServer | null = null;
  #clients = new Set<WebSocket>();
  #token = "test-token";
  #port = 0;
  #messageId = 1000;
  readonly actions: OneBotActionRecord[] = [];

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}`;
  }

  async start(token = "test-token"): Promise<void> {
    if (this.#httpServer !== null) return;
    this.#token = token;
    const httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end("Not Found");
    });
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.searchParams.get("access_token") !== this.#token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (websocket) => {
        wss.emit("connection", websocket, request);
      });
    });

    wss.on("connection", (websocket) => {
      this.#clients.add(websocket);
      websocket.on("close", () => this.#clients.delete(websocket));
      websocket.on("message", (data) => this.#handleAction(websocket, data.toString()));
      this.#send(websocket, {
        time: Math.floor(Date.now() / 1000),
        self_id: 10000,
        post_type: "meta_event",
        meta_event_type: "lifecycle",
        sub_type: "connect",
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", onError);
        resolve();
      });
    });
    this.#port = (httpServer.address() as AddressInfo).port;
    this.#httpServer = httpServer;
    this.#wss = wss;
  }

  async stop(): Promise<void> {
    for (const client of this.#clients) client.terminate();
    this.#clients.clear();
    const wss = this.#wss;
    this.#wss = null;
    if (wss !== null) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    const server = this.#httpServer;
    this.#httpServer = null;
    if (server !== null) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  sendEvent(event: Record<string, unknown>): void {
    for (const client of this.#clients) this.#send(client, event);
  }

  #handleAction(websocket: WebSocket, raw: string): void {
    let request: OneBotAction;
    try {
      request = JSON.parse(raw) as OneBotAction;
    } catch {
      return;
    }
    let response: unknown = {};
    switch (request.action) {
      case "get_login_info":
        response = { user_id: 10000, nickname: "FakeNapCat" };
        break;
      case "send_private_msg":
      case "send_group_msg":
        response = { message_id: ++this.#messageId };
        break;
      case "upload_private_file":
      case "upload_group_file":
        response = null;
        break;
      default:
        response = {};
        break;
    }
    this.actions.push({ action: request.action, params: request.params, response });
    this.#send(websocket, {
      status: "ok",
      retcode: 0,
      data: response,
      message: "",
      wording: "",
      echo: request.echo,
    });
  }

  #send(websocket: WebSocket, payload: unknown): void {
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify(payload));
    }
  }
}
