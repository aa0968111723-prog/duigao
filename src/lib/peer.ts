import Peer, { type DataConnection } from "peerjs";
import type { PeerMsg } from "./types";

const PEER_PREFIX = "duigao-";
/** Backoff between reconnection attempts; the last value repeats forever. */
const RETRY_MS = [1500, 3000, 6000, 10000, 15000];

export type CollabRole = "host" | "guest";
export type CollabStatus = "connecting" | "online" | "waiting" | "error" | "closed";

type PeerError = { type?: string; message: string };

type Handlers = {
  onMessage: (msg: PeerMsg, conn: DataConnection) => void;
  onStatus: (status: CollabStatus, detail?: string) => void;
  onOpenConn?: (conn: DataConnection) => void;
};

/**
 * Thin PeerJS wrapper for room sync. A host claims the deterministic peer id
 * derived from the room code so guests can find it.
 *
 * Everything here is best-effort and self-healing: a guest whose host is not
 * online yet reports `waiting` and keeps retrying with backoff instead of
 * failing once, and a host whose id is still held by a previous session (very
 * common right after a reload) retries until the broker releases it.
 */
export class Collab {
  readonly role: CollabRole;
  readonly code: string;
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  private handlers: Handlers;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = false;

  constructor(role: CollabRole, code: string, handlers: Handlers) {
    this.role = role;
    this.code = code;
    this.handlers = handlers;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  /**
   * Immediate retry, e.g. the user tapped 重新連線 or the tab became visible.
   *
   * Returns early while the link is healthy: this fires on every
   * visibilitychange, and redialing a working link would tear the host's peer
   * down (dropping every connected partner) or stack duplicate guest channels.
   */
  retryNow(): void {
    if (this.stopped || this.isHealthy()) return;
    this.attempt = 0;
    this.clearTimer();
    this.handlers.onStatus("connecting");
    this.dial();
  }

  /** A host is reachable once its id is open; a guest needs a live channel. */
  private isHealthy(): boolean {
    if (!this.peer || this.peer.destroyed || !this.peer.open) return false;
    return this.role === "host" || this.peerCount > 0;
  }

  private open(): void {
    if (this.stopped) return;
    this.clearTimer();
    try {
      this.peer = this.role === "host" ? new Peer(PEER_PREFIX + this.code) : new Peer();
    } catch (err) {
      this.handlers.onStatus("error", String(err));
      this.scheduleRetry();
      return;
    }

    this.handlers.onStatus("connecting");
    this.peer.on("error", (err) => this.onError(err as PeerError));
    this.peer.on("disconnected", () => {
      if (!this.stopped) this.peer?.reconnect();
    });

    if (this.role === "host") {
      this.peer.on("open", () => {
        this.attempt = 0;
        this.handlers.onStatus("online");
      });
      this.peer.on("connection", (conn) => this.register(conn));
    } else {
      this.peer.on("open", () => this.dialThroughPeer());
    }
  }

  /** Reuse the open peer when possible, otherwise build a fresh one. */
  private dial(): void {
    if (this.role === "guest" && this.peer && !this.peer.destroyed && this.peer.open) {
      this.dialThroughPeer();
      return;
    }
    this.teardownPeer();
    this.open();
  }

  private dialThroughPeer(): void {
    const conn = this.peer!.connect(PEER_PREFIX + this.code, { reliable: true });
    this.register(conn);
  }

  private onError(err: PeerError): void {
    // The host is simply not online yet — keep waiting rather than giving up.
    if (err.type === "peer-unavailable") {
      this.handlers.onStatus("waiting", err.message);
      this.scheduleRetry();
      return;
    }
    // Our own id from a previous session is still held by the broker.
    if (err.type === "unavailable-id") {
      this.teardownPeer();
      this.scheduleRetry();
      return;
    }
    this.handlers.onStatus(this.role === "guest" ? "waiting" : "error", err.message);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer !== null) return;
    const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt += 1;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.dial();
    }, delay);
  }

  private register(conn: DataConnection): void {
    this.conns.set(conn.peer, conn);
    conn.on("open", () => {
      this.attempt = 0;
      this.clearTimer();
      this.handlers.onStatus("online");
      this.handlers.onOpenConn?.(conn);
    });
    conn.on("data", (data) => this.handlers.onMessage(data as PeerMsg, conn));
    conn.on("close", () => {
      this.conns.delete(conn.peer);
      if (this.stopped) return;
      if (this.role === "guest") {
        this.handlers.onStatus("waiting");
        this.scheduleRetry();
      } else {
        this.handlers.onStatus("online");
      }
    });
    conn.on("error", (err) => this.onError(err as unknown as PeerError));
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
    let open = 0;
    for (const conn of this.conns.values()) if (conn.open) open += 1;
    return open;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private teardownPeer(): void {
    for (const conn of this.conns.values()) conn.close();
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null;
  }

  destroy(): void {
    this.stopped = true;
    this.clearTimer();
    this.teardownPeer();
    this.handlers.onStatus("closed");
  }
}
