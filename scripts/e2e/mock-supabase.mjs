/**
 * Minimal stand-in for the Supabase endpoints this app uses, so the share flow
 * can be exercised end-to-end in a sandbox with no outbound network.
 * Implements: anonymous auth, the invite RPCs (with membership + invite-token
 * checks), PostgREST-ish table reads/writes, Storage upload/sign/serve (private
 * and public buckets), and — when started with an `appOrigin` — the real
 * `share-preview` Edge Function mounted where Supabase would serve it.
 */
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { loadSharePreviewHandler, serveHandler } from "./edge-function.mjs";

const PORT = Number(process.env.MOCK_PORT || 54399);

const users = new Map(); // token -> userId
const rooms = new Map(); // roomId -> { id, owner_user_id, title, invite_hash, created_at, updated_at }
const members = new Map(); // roomId -> Set(userId)
const tables = {
  versions: [], comments: [], strokes: [], messages: [], visual_proposals: [],
  comment_supports: [], comment_replies: [], proposal_preferences: [],
  share_previews: [],
};
const objects = new Map(); // `${bucket}/${path}` -> {buf, mime}

/**
 * Every request the app made, as `METHOD /path`. Lets a run assert not just the
 * outcome but the route taken — e.g. that a share thumbnail was rendered from
 * the original poster in Storage rather than from a screenshot of the page.
 */
export const requestLog = [];

/**
 * Fault injection. A run can make the next thumbnail upload fail to check that
 * the app self-heals — a preview that gets stuck advertising an old poster is
 * invisible in the happy path.
 */
export const faults = { previewUpload: false, previewDelete: false };

/** Row access for assertions (e.g. which version a preview currently points at). */
export const rows = tables;

const sha = (s) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

/**
 * Serve a stored object, honouring Range.
 *
 * Media is the reason this exists: a `<video>` seeks by asking for byte ranges,
 * and a server that always answers 200 with the whole file makes seeking look
 * like it works in tests while it may not in production. Answering 206 here
 * means the app's playback and scrub paths are exercised the way Storage
 * actually serves them.
 */
function serveObject(req, res, obj) {
  cors(res);
  const total = obj.buf.length;
  const range = req.headers.range;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range || ""));
  if (!match) {
    res.writeHead(200, {
      "content-type": obj.mime,
      "content-length": total,
      "accept-ranges": "bytes",
    });
    return res.end(req.method === "HEAD" ? undefined : obj.buf);
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  if (Number.isNaN(start) || start >= total || end < start) {
    res.writeHead(416, { "content-range": `bytes */${total}` });
    return res.end();
  }
  res.writeHead(206, {
    "content-type": obj.mime,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${total}`,
    "accept-ranges": "bytes",
  });
  return res.end(req.method === "HEAD" ? undefined : obj.buf.subarray(start, end + 1));
}

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

/**
 * PostgREST answers `Accept: application/vnd.pgrst.object+json` with the bare
 * object, or 406/PGRST116 when the row count is not exactly one — which is how
 * supabase-js tells `.single()` from `.maybeSingle()`. Getting this wrong makes
 * an empty result look like a truthy `[]` to the client, so the mock models it.
 */
function respondRows(req, res, rows) {
  const wantsObject = String(req.headers.accept || "").includes("vnd.pgrst.object");
  if (!wantsObject) return json(res, 200, rows);
  if (rows.length === 1) return json(res, 200, rows[0]);
  return json(res, 406, {
    code: "PGRST116",
    message: rows.length === 0 ? "JSON object requested, multiple (or no) rows returned" : "multiple rows",
    details: `Results contain ${rows.length} rows`,
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

/** Set by start({ appOrigin }) — mounts the real Edge Function at /functions/v1. */
let previewHandler = null;
let mockOrigin = `http://127.0.0.1:${PORT}`;

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  requestLog.push(`${req.method} ${p}${url.search ? url.search.slice(0, 90) : ""}`);
  if (process.env.MOCK_LOG) console.log(req.method, req.url.slice(0, 140));
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }

  // ---- Edge Functions ----
  if (previewHandler && p.startsWith("/functions/v1/share-preview")) {
    return serveHandler(previewHandler, req, res, mockOrigin);
  }

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

    // The one anon-reachable read: the public share-card projection. It never
    // returns room_id, so a preview id can not be walked back to a room.
    if (fn === "get_share_preview") {
      const row = tables.share_previews.find((r) => r.id === body.p_preview_id && r.enabled);
      return json(res, 200, row
        ? [{
            title: row.title,
            description: row.description,
            image_path: row.show_thumbnail ? row.thumbnail_path : null,
            updated_at: row.updated_at || now(),
          }]
        : []);
    }

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
      return respondRows(req, res, rows);
    }
    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString() || "[]");
      const rows = Array.isArray(body) ? body : [body];
      for (const row of rows) {
        if (!isMember(row.room_id, uid)) return json(res, 403, { message: "not a member" });
        if (tables[table].some((r) => r.id === row.id)) return json(res, 409, { message: "duplicate key value" });
        tables[table].push({ created_at: now(), updated_at: now(), ...row });
      }
      cors(res); res.writeHead(201); return res.end("[]");
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse((await readBody(req)).toString() || "{}");
      const rows = filterRows(tables[table], url.searchParams).filter((r) => isMember(r.room_id, uid));
      // `updated_at` moves on every write, exactly like the SQL trigger — the
      // client derives its cache-busting `?v=` from it.
      for (const row of rows) Object.assign(row, patch, { updated_at: now() });
      if (String(req.headers.prefer || "").includes("return=representation")) return respondRows(req, res, rows);
      cors(res); res.writeHead(204); return res.end();
    }
    if (req.method === "DELETE") {
      await readBody(req);
      cors(res); res.writeHead(204); return res.end();
    }
  }

  // ---- storage ----
  // Bucket-generic on purpose: `room-assets` stays private while PR #21's
  // `share-previews` is served from the public route, and the mock has to be
  // able to tell those two apart.
  if (p.startsWith("/storage/v1/object/")) {
    const rest = p.slice("/storage/v1/object/".length);
    const [head, ...tail] = rest.split("/");

    if (head === "sign") {
      const [bucket, ...rel] = tail;
      const path = decodeURIComponent(rel.join("/"));
      if (req.method === "POST") {
        await readBody(req);
        return json(res, 200, { signedURL: `/object/sign/${bucket}/${path}?token=mock` });
      }
      const obj = objects.get(`${bucket}/${path}`);
      if (!obj) { cors(res); res.writeHead(404); return res.end(); }
      return serveObject(req, res, obj);
    }

    if (head === "public") {
      // Anonymous read — no auth header at all, like a social crawler.
      const [bucket, ...rel] = tail;
      const obj = objects.get(`${bucket}/${decodeURIComponent(rel.join("/"))}`);
      if (!obj) { cors(res); res.writeHead(404); return res.end(); }
      return serveObject(req, res, obj);
    }

    const bucket = head;
    const path = decodeURIComponent(tail.join("/"));
    if (req.method === "POST" || req.method === "PUT") {
      const raw = await readBody(req);
      if (bucket === "share-previews" && faults.previewUpload) {
        return json(res, 500, { message: "injected upload failure" });
      }
      const ct = String(req.headers["content-type"] || "image/png");
      // storage-js uploads through FormData in browsers; keep only the file part.
      const { buf, mime } = ct.startsWith("multipart/form-data") ? unwrapMultipart(raw, ct) : { buf: raw, mime: ct };
      objects.set(`${bucket}/${path}`, { buf, mime });
      return json(res, 200, { Key: `${bucket}/${path}` });
    }
    if (req.method === "DELETE") {
      // storage-js `remove(paths)` DELETEs the bucket with {prefixes:[...]}.
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      if (bucket === "share-previews" && faults.previewDelete) {
        return json(res, 500, { message: "injected delete failure" });
      }
      const gone = [];
      for (const prefix of body.prefixes ?? []) {
        if (objects.delete(`${bucket}/${prefix}`)) gone.push({ name: prefix });
      }
      return json(res, 200, gone);
    }
    const obj = objects.get(`${bucket}/${path}`);
    if (!obj) { cors(res); res.writeHead(404); return res.end(); }
    return serveObject(req, res, obj);
  }

  cors(res);
  res.writeHead(404);
  res.end(JSON.stringify({ message: `no mock route for ${req.method} ${p}` }));
});

export async function start(port = PORT, options = {}) {
  mockOrigin = `http://127.0.0.1:${port}`;
  if (options.appOrigin) {
    previewHandler = await loadSharePreviewHandler({
      supabaseUrl: mockOrigin,
      anonKey: "sb_publishable_e2e_mock_key_000000",
      appOrigin: options.appOrigin.replace(/\/+$/, ""),
    });
  }
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// `node scripts/e2e/mock-supabase.mjs` runs it standalone for manual poking.
if (process.argv[1] && process.argv[1].endsWith("mock-supabase.mjs")) {
  await start();
  console.log(`mock supabase on http://127.0.0.1:${PORT}`);
}
