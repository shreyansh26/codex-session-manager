import type { RpcNotification } from "../domain/types";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

export class JsonRpcClient {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingResolver>();
  private readonly notificationHandlers = new Set<(notification: RpcNotification) => void>();
  private static readonly CONNECT_MAX_ATTEMPTS = 45;
  private static readonly CONNECT_RETRY_DELAY_MS = 250;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      await this.waitForOpen(this.socket);
      return;
    }

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= JsonRpcClient.CONNECT_MAX_ATTEMPTS; attempt += 1) {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });

      socket.addEventListener("close", () => {
        for (const [id, resolver] of this.pending) {
          resolver.reject(new Error(`RPC request ${id} aborted: websocket closed`));
        }
        this.pending.clear();
      });

      socket.addEventListener("error", () => {
        // The close handler will reject pending calls.
      });

      try {
        await this.waitForOpen(socket);
        return;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error(`Failed to connect to websocket endpoint: ${this.url}`);
        try {
          socket.close();
        } catch {
          // Ignore close failures while retrying.
        }
        if (this.socket === socket) {
          this.socket = null;
        }

        if (attempt < JsonRpcClient.CONNECT_MAX_ATTEMPTS) {
          await sleep(JsonRpcClient.CONNECT_RETRY_DELAY_MS);
        }
      }
    }

    throw (
      lastError ?? new Error(`Failed to connect to websocket endpoint: ${this.url}`)
    );
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params })
    };

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
    });

    this.socket.send(JSON.stringify(payload));
    return responsePromise;
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  private async waitForOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Failed to connect to websocket endpoint: ${this.url}`));
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`Websocket closed while connecting: ${this.url}`));
      };

      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!isObject(parsed)) {
      return;
    }

    if (typeof parsed.method === "string") {
      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: parsed.method,
        params: parsed.params
      };
      for (const handler of this.notificationHandlers) {
        handler({ method: notification.method, params: notification.params });
      }
      return;
    }

    if (typeof parsed.id === "number") {
      const response = parsed as unknown as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) {
        return;
      }

      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(
          new Error(`${response.error.message} (code ${response.error.code})`)
        );
      } else {
        pending.resolve(response.result);
      }
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const sleep = (durationMs: number): Promise<void> =>
  new Promise((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
