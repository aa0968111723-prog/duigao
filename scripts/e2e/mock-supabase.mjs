/**
 * Minimal stand-in for the Supabase endpoints this app uses, so the PR #16
 * share flow can be exercised end-to-end in a sandbox with no outbound network.
 * Implements: anonymous auth, the invite RPCs (with membership + invite-token
 * checks), PostgREST-ish table reads/writes, and Storage upload/sign/serve.
 */
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT || 54399);

const users = new Map(); // token -> userId
const rooms = new Map(); // roomId -> { id, owner_user_id, title, invite_hash, created_at, updated_at }
const members = new Map(); // roomId -> Set(userId)
const tables = {
  versions: [], comments: [], strokes: [], messages: [], visual_proposals: [],
  comment_supports: [], comment_replies: [], proposal_preferences: [],
};
const objects = new Map(); // path -> {buf, mime}

const sha = (s) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-expose-headers", "*");
}
function json(res, code, body) {
  cors(res);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function userOf(req) {
  const auth = req.headers.authorization || "";
  const t = auth.replace(/^Bearer\s+/i, "");
  return users.get(t) || null;
}
function isMember(roomId, uid) {
  return Boolean(uid && members.get(roomId)?.has(uid));
}
function session(uid) {
  const token = `tok_${randomUUID()}`;
  users.set(token, uid);
  return {
    access_token: token,
    token_type: "bearer",
    expires_in: 36000,
    expires_at: Math.floor(Date.now() / 1000) + 36000,
    refresh_token: `ref_${randomUUID()}`,
    user: {
      id: uid, aud: "authenticated", role: "authenticated", email: "", phone: "",
      is_anonymous: true, app_metadata: {}, user_metadata: {},
      created_at: now(), updated_at: now(),
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** `?select=*&room_id=eq.<id>&order=...` — only the `eq.` filters this app uses. */
function filterRows(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    if (typeof v === "string" && v.startsWith("eq.")) {
      const want = v.slice(3);
      out = out.filter((r) => String(r[k]) === want);
    }
  }
  return out;
}

/** Pull the single file part out of a multipart/form-data body. */
function unwrapMultipart(raw, contentType) {
  const boundary = `--${/boundary=(.*)$/.exec(contentType)?.[1] ?? ""}`;
  const parts = raw.toString("latin1").split(boundary).filter((s) => s.includes("\r\n\r\n"));
  for (const part of parts) {
    const head = part.slice(0, part.indexOf("\r\n\r\n"));
    if (!/filename=/i.test(head) && !/Content-Type:\s*image/i.test(head)) continue;
    const start = part.indexOf("\r\n\r\n") + 4;
    const body = part.slice(start).replace(/\r\n$/, "");
    const mime = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? "image/png";
    return { buf: Buffer.from(body, "latin1"), mime };
  }
  return { buf: raw, mime: "application/octet-stream" };
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (process.env.MOCK_LOG) console.log(req.method, req.url.slice(0, 140));
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  // ---- auth ----
  if (p === "/auth/v1/signup" || p === "/auth/v1/token") {
    await readBody(req);
    return json(res, 200, session(randomUUID()));
  }
  if (p === "/auth/v1/user") {
    const uid = userOf(req);
    if (!uid) return json(res, 401, { message: "not authenticated" });
    return json(res, 200, { id: uid, aud: "authenticated", role: "authenticated", is_anonymous: true, app_metadata: {}, user_metadata: {} });
  }
  if (p.startsWith("/auth/v1/logout")) { cors(res); res.writeHead(204); return res.end(); }

  // ---- RPC ----
  if (p.startsWith("/rest/v1/rpc/")) {
    const fn = p.slice("/rest/v1/rpc/".length);
    const body = JSON.parse((await readBody(req)).toString() || "{}");
    const uid = userOf(req);
    if (!uid) return json(res, 401, { message: "auth required" });

    if (fn === "create_room_with_invite") {
      if (!body.p_invite_token || body.p_invite_token.length < 16) return json(res, 400, { message: "invalid invite" });
      rooms.set(body.p_room_id, {
        id: body.p_room_id, owner_user_id: uid, title: body.p_title || "未命名文宣",
        invite_hash: sha(body.p_invite_token), created_at: now(), updated_at: now(),
      });
      members.set(body.p_room_id, new Set([uid]));
      return json(res, 200, body.p_room_id);
    }
    if (fn === "join_room_by_invite") {
      const room = rooms.get(body.p_room_id);
      // Same generic error as the real RPC: never disclose that a room exists.
      if (!room || room.invite_hash !== sha(body.p_invite_token || "")) return json(res, 400, { message: "invalid invite" });
      members.get(body.p_room_id).add(uid);
      return json(res, 200, body.p_room_id);
    }
    if (fn === "upsert_visual_proposal") {
      const row = {
        id: body.p_id, room_id: body.p_room_id, version_id: body.p_version_id,
        author_name: body.p_author_name, name: body.p_name, payload: body.p_payload,
        revision: (body.p_expected_revision ?? 0) + 1, created_at: now(),
      };
      const i = tables.visual_proposals.findIndex((r) => r.id === row.id);
      if (i >= 0) tables.visual_proposals[i] = row; else tables.visual_proposals.push(row);
      return json(res, 200, row.revision);
    }
    return json(res, 404, { message: `unknown rpc ${fn}` });
  }

  // ---- tables ----
  if (p.startsWith("/rest/v1/")) {
    const table = p.slice("/rest/v1/".length);
    const uid = userOf(req);
    if (!uid) return json(res, 401, { message: "auth required" });

    if (table === "rooms") {
      if (req.method === "GET") {
        const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
        const room = rooms.get(id);
        // RLS stand-in: non-members must not read the room.
        if (!room || !isMember(id, uid)) return json(res, 406, { message: "no rows" });
        const single = String(req.headers.accept || "").includes("vnd.pgrst.object");
        return json(res, 200, single ? room : [room]);
      }
      if (req.method === "PATCH") {
        const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
        const patch = JSON.parse((await readBody(req)).toString() || "{}");
        if (rooms.has(id) && isMember(id, uid)) Object.assign(rooms.get(id), patch, { updated_at: now() });
        cors(res); res.writeHead(204); return res.end();
      }
    }

    if (!(table in tables)) return json(res, 404, { message: `unknown table ${table}` });

    if (req.method === "GET") {
      const rows = filterRows(tables[table], url.searchParams).filter((r) => isMember(r.room_id, uid));
      return json(res, 200, rows);
    }
    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString() || "[]");
      const rows = Array.isArray(body) ? body : [body];
      for (const row of rows) {
        if (!isMember(row.room_id, uid)) return json(res, 403, { message: "not a member" });
        if (tables[table].some((r) => r.id === row.id)) return json(res, 409, { message: "duplicate key value" });
        tables[table].push({ created_at: now(), ...row });
      }
      cors(res); res.writeHead(201); return res.end("[]");
    }
    if (req.method === "PATCH" || req.method === "DELETE") {
      await readBody(req);
      cors(res); res.writeHead(204); return res.end();
    }
  }

  // ---- storage ----
  if (p.startsWith("/storage/v1/object/sign/")) {
    const path = decodeURIComponent(p.slice("/storage/v1/object/sign/room-assets/".length));
    if (req.method === "POST") {
      await readBody(req);
      return json(res, 200, { signedURL: `/object/sign/room-assets/${path}?token=mock` });
    }
    const obj = objects.get(path);
    if (!obj) { cors(res); res.writeHead(404); return res.end(); }
    cors(res); res.writeHead(200, { "content-type": obj.mime }); return res.end(obj.buf);
  }
  if (p.startsWith("/storage/v1/object/")) {
    const path = decodeURIComponent(p.slice("/storage/v1/object/room-assets/".length));
    if (req.method === "POST" || req.method === "PUT") {
      const raw = await readBody(req);
      const ct = String(req.headers["content-type"] || "image/png");
      // storage-js uploads through FormData in browsers; keep only the file part.
      const { buf, mime } = ct.startsWith("multipart/form-data") ? unwrapMultipart(raw, ct) : { buf: raw, mime: ct };
      objects.set(path, { buf, mime });
      return json(res, 200, { Key: `room-assets/${path}` });
    }
    const obj = objects.get(path);
    if (!obj) { cors(res); res.writeHead(404); return res.end(); }
    cors(res); res.writeHead(200, { "content-type": obj.mime }); return res.end(obj.buf);
  }

  cors(res);
  res.writeHead(404);
  res.end(JSON.stringify({ message: `no mock route for ${req.method} ${p}` }));
});

export function start(port = PORT) {
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// `node scripts/e2e/mock-supabase.mjs` runs it standalone for manual poking.
if (process.argv[1] && process.argv[1].endsWith("mock-supabase.mjs")) {
  await start();
  console.log(`mock supabase on http://127.0.0.1:${PORT}`);
}
