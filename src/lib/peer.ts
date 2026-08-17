import Peer, { type DataConnection } from "peerjs";
import type { PeerMsg } from "./types";

const PEER_PREFIX = "duigao-";

export type CollabRole = "host" | "guest";
export type CollabStatus = "connecting" | "online" | "error" | "closed";

type Handlers = {
  onMessage: (msg: PeerMsg, conn: DataConnection) => void;
  onStatus: (status: CollabStatus, detail?: string) => void;
  onOpenConn?: (conn: DataConnection) => void;
};

/**
 * Thin PeerJS wrapper for room sync. A host claims the deterministic peer id
 * derived from the room code so guests can find it. All networking is
 * best-effort: failures degrade to a local-only session instead of throwing.
 */
export class Collab {
  readonly role: CollabRole;
  readonly code: string;
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  private handlers: Handlers;

  constructor(role: CollabRole, code: string, handlers: Handlers) {
    this.role = role;
    this.code = code;
    this.handlers = handlers;
  }

  connect(): void {
    const hostId = PEER_PREFIX + this.code;
    try {
      this.peer = this.role === "host" ? new Peer(hostId) : new Peer();
    } catch (err) {
      this.handlers.onStatus("error", String(err));
      return;
    }

    this.peer.on("error", (err) => this.handlers.onStatus("error", err.message));

    if (this.role === "host") {
      this.peer.on("open", () => this.handlers.onStatus("online"));
      this.peer.on("connection", (conn) => this.register(conn));
    } else {
      this.peer.on("open", () => {
        this.handlers.onStatus("connecting");
        const conn = this.peer!.connect(hostId, { reliable: true });
        this.register(conn);
      });
    }
  }

  private register(conn: DataConnection): void {
    this.conns.set(conn.peer, conn);
    conn.on("open", () => {
      this.handlers.onStatus("online");
      this.handlers.onOpenConn?.(conn);
    });
    conn.on("data", (data) => this.handlers.onMessage(data as PeerMsg, conn));
    conn.on("close", () => this.conns.delete(conn.peer));
    conn.on("error", (err) => this.handlers.onStatus("error", err.message));
  }

  send(msg: PeerMsg): void {
    for (const conn of this.conns.values()) {
      if (conn.open) {
        try {
          conn.send(msg);
        } catch {
          /* drop message if the channel is not writable */
        }
      }
    }
  }

  sendTo(conn: DataConnection, msg: PeerMsg): void {
    if (conn.open) {
      try {
        conn.send(msg);
      } catch {
        /* ignore */
      }
    }
  }

  get peerCount(): number {
    return this.conns.size;
  }

  destroy(): void {
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null;
    this.handlers.onStatus("closed");
  }
}
