/**
 * tku-zen-agent context adapter.
 *
 * HMAC contract: `sha256(timestamp + "." + body)` in `x-duigao-signature`,
 * 300s clock skew. The edge function already signs outbound calls; this module
 * is the shared verifier / answer shaper so tests and a future inbound webhook
 * use the same rules.
 */

export const DUIGAO_SIGNATURE_SKEW_SECONDS = 300;

export type RoomContextAnswer = {
  text: string;
  citations: Array<{ sourceId: string; title?: string }>;
  actions: Array<{ type: string; label: string; payload?: Record<string, unknown> }>;
};

export type RoomContextAsk = {
  query: string;
  context?: unknown[];
  sources?: unknown[];
  relations?: unknown[];
};

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signDuigaoRequest(body: string, timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return bytesToHex(digest);
}

export async function verifyDuigaoHmac(body: string, timestamp: string, signature: string, secret: string): Promise<boolean> {
  const expected = await signDuigaoRequest(body, timestamp, secret);
  const given = signature.replace(/^sha256=/i, "").trim().toLowerCase();
  if (given.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return mismatch === 0;
}

export function requireDuigaoSignature(input: {
  body: string;
  timestamp: string;
  signature: string;
  secret: string;
  nowSeconds?: number;
}): Promise<void> {
  return (async () => {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const ts = Number(input.timestamp);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > DUIGAO_SIGNATURE_SKEW_SECONDS) {
      throw new Error("invalid duigao signature timestamp");
    }
    const ok = await verifyDuigaoHmac(input.body, input.timestamp, input.signature, input.secret);
    if (!ok) throw new Error("invalid duigao signature");
  })();
}

const ALLOWED_ACTIONS = new Set(["create_comment", "create_poll", "create_plan_draft", "add_whiteboard_node"]);

export function answerRoomContext(ask: RoomContextAsk, raw: Record<string, unknown> | null): RoomContextAnswer | null {
  if (!ask.query.trim()) return null;
  const text = typeof raw?.text === "string" ? raw.text : typeof raw?.answer === "string" ? raw.answer : "";
  if (!text.trim()) return null;
  const citations = Array.isArray(raw?.citations)
    ? raw.citations.slice(0, 8).flatMap((item) => {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const sourceId = typeof row.sourceId === "string" ? row.sourceId : typeof row.source_id === "string" ? row.source_id : "";
        if (!sourceId) return [];
        return [{ sourceId, title: typeof row.title === "string" ? row.title : undefined }];
      })
    : [];
  const actions = Array.isArray(raw?.actions)
    ? raw.actions.slice(0, 6).flatMap((item) => {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        const type = typeof row.type === "string" ? row.type : "";
        const label = typeof row.label === "string" ? row.label.trim() : "";
        if (!ALLOWED_ACTIONS.has(type) || !label) return [];
        const payload = row.payload && typeof row.payload === "object" ? stripSecrets(row.payload as Record<string, unknown>) : undefined;
        return [{ type, label, payload }];
      })
    : [];
  return { text: text.replace(/https?:\/\/[^\s)]+/gi, "[連結已省略]").slice(0, 5000), citations, actions };
}

export function stripSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const blocked = /secret|token|authorization|service[_-]?role|invite|storage[_-]?path/i;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (blocked.test(key)) continue;
    out[key] = item;
  }
  return out;
}
