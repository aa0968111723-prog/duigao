/**
 * Minimal stand-in for the Supabase endpoints this app uses, so the share flow
 * can be exercised end-to-end in a sandbox with no outbound network.
 * Implements: anonymous auth, the invite RPCs (with membership + invite-token
 * checks), PostgREST-ish table reads/writes, Storage upload/sign/serve (private
 * and public buckets), Realtime (Phoenix channels over a hand-rolled
 * WebSocket, so a run can prove one tab sees another tab's write), and — when
 * started with an `appOrigin` — the real `share-preview` Edge Function mounted
 * where Supabase would serve it.
 */
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { loadSharePreviewHandler, serveHandler } from "./edge-function.mjs";

const PORT = Number(process.env.MOCK_PORT || 54399);

const users = new Map(); // token -> userId
const rooms = new Map(); // roomId -> { id, owner_user_id, title, room_mode, invite_hash, created_at, updated_at }
const members = new Map(); // roomId -> Set(userId)
/**
 * `${roomId}:${userId}` -> 'owner' | 'editor' | 'reviewer'.
 *
 * Modelled because the capability split is a real part of the product, not a
 * database detail: 0007 hands the creator `owner` and everyone arriving through
 * a share link `reviewer`. Without this every participant in a browser run read
 * back as `editor`, so the reviewer experience — the one most partners actually
 * get — was never exercised above the SQL layer.
 */
const memberRoles = new Map();
const roleKey = (roomId, uid) => `${roomId}:${uid}`;

/**
 * What the next join-by-link hands out.
 *
 * Defaults to `editor`, which is what every leg written before this knob
 * assumed — a room created before 0007 backfills to `editor`, and legs like P
 * (a partner adding their own cut) depend on it. A leg that wants to exercise
 * the reviewer half sets this to 'reviewer' first, which is what 0007 gives a
 * partner joining a room created today.
 */
export const roles = { nextJoinRole: "editor" };
const tables = {
  versions: [], comments: [], strokes: [], messages: [], visual_proposals: [],
  comment_supports: [], comment_replies: [], proposal_preferences: [],
  share_previews: [],
  // 同房多分支 1.0
  room_branches: [], plan_documents: [], content_relations: [], room_polls: [], room_poll_votes: [],
  // 影片對稿 2.0 (PR #32)
  version_review_briefs: [], video_reactions: [], version_verdicts: [],
  version_review_progress: [],
};

/**
 * Natural keys for the tables the app upserts into, standing in for the SQL
 * primary keys. Without these an upsert would append instead of replacing and
 * "one verdict per person per cut" would quietly stop being true.
 */
const CONFLICT_KEYS = {
  plan_documents: ["branch_id"],
  room_poll_votes: ["poll_id", "user_id"],
  version_review_briefs: ["version_id"],
  version_verdicts: ["version_id", "user_id"],
  version_review_progress: ["version_id", "user_id"],
};

/**
 * The unique index that stops a double-tap becoming two dots: same person, same
 * cut, same reaction, same two-second bucket.
 */
function reactionDedupeKey(row) {
  return [row.version_id, row.user_id, row.reaction_type, Math.floor(Number(row.time_seconds) / 2)].join("|");
}

/**
 * The `comments_sync_review_status` trigger from 0012.
 *
 * `resolved` and `review_status` are two views of one fact, and whichever one
 * the caller actually changed wins. Modelled here so the browser suites see the
 * same behaviour they will see against Postgres — including an old client that
 * only knows `resolved`.
 */
function applyCommentStatus(row, before) {
  const RESOLVED = ["done", "wontfix"];
  if (!before) {
    if (row.review_status && row.review_status !== "open") {
      row.resolved = RESOLVED.includes(row.review_status);
    } else {
      row.review_status = row.resolved ? "done" : "open";
    }
    return;
  }
  if (row.review_status !== before.review_status) {
    row.resolved = RESOLVED.includes(row.review_status);
  } else if (row.resolved !== before.resolved) {
    row.review_status = row.resolved ? "done" : "open";
  }
}
const objects = new Map(); // `${bucket}/${path}` -> {buf, mime}
const signedUrls = new Map(); // token -> { bucket, path, expiresAt }

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
export const faults = {
  previewUpload: false,
  previewDelete: false,
  /** Next video upload into room-assets fails, for testing the retry path. */
  videoUpload: false,
  /** Next createSignedUrl fails, for the "row landed, signing did not" case. */
  sign: false,
  /** Override createSignedUrl TTL in seconds for expiry tests. */
  signTtl: null,
  /** Fail this many room-assets deletes before allowing cleanup to succeed. */
  assetDelete: 0,
  /** Fail the next versions insert after Storage has accepted the bytes. */
  versionInsert: false,
  /**
   * Hold every share-previews upload open for this many ms. Not a fault: it
   * widens the window in which a card is still `building`, which is the exact
   * window PR #30's race lived in and is otherwise too short to observe.
   */
  previewUploadDelayMs: 0,
};

/** Row access for assertions (e.g. which version a preview currently points at). */
export const rows = tables;
export const storageObjects = objects;

/** Expire every token for a path, modelling a signed URL expiring in-place. */
export function expireSignedUrls(path) {
  for (const token of signedUrls.values()) {
    if (token.path === path) token.expiresAt = 0;
  }
}

/**
 * The rooms themselves, for assertions that care about rooms with nothing in
 * them — an abandoned upload's leftovers are invisible to `rows`, because a
 * room with no versions and no comments appears in no child table.
 */
export const cloudRooms = rooms;

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
    if (typeof v === "string" && v.startsWith("in.(")) {
      const values = v.slice(4, -1).split(",").map((item) => item.replace(/^\"|\"$/g, ""));
      out = out.filter((r) => values.includes(String(r[k])));
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
    // v3 (PR #30) adds media_type, and answers for revoked previews too — with
    // every content field nulled, so the card falls back to the RIGHT brand
    // instead of calling a video 「文宣討論區」. Still no room_id, ever.
    if (fn === "get_share_preview_v3") {
      const row = tables.share_previews.find((r) => r.id === body.p_preview_id);
      return json(res, 200, row
        ? [{
            title: row.enabled ? row.title : null,
            description: row.enabled ? row.description : null,
            image_path: row.enabled && row.show_thumbnail ? row.thumbnail_path : null,
            media_type: row.media_type === "video" ? "video" : "image",
            updated_at: row.updated_at || now(),
            version_archived: false,
            revoked: !row.enabled,
          }]
        : []);
    }
    if (fn === "get_room_branch_summaries") {
      const uid = userOf(req);
      if (!uid || !isMember(body.p_room_id, uid)) return json(res, 200, []);
      const summaries = tables.room_branches
        .filter((branch) => branch.room_id === body.p_room_id)
        .map((branch) => {
          const versions = tables.versions
            .filter((version) => version.room_id === body.p_room_id && version.branch_id === branch.id && !version.archived_at)
            .sort((a, b) => Number(b.sort_order ?? 0) - Number(a.sort_order ?? 0) || String(b.created_at).localeCompare(String(a.created_at)));
          const versionIds = new Set(versions.map((version) => version.id));
          const comments = tables.comments.filter((comment) => versionIds.has(comment.version_id));
          return {
            branch_id: branch.id,
            version_count: versions.length,
            latest_version_id: versions[0]?.id ?? null,
            latest_label: versions[0]?.label ?? null,
            latest_updated_at: versions[0]?.created_at ?? null,
            open_comment_count: comments.filter((comment) => !comment.resolved).length,
            feedback_count: comments.length,
          };
        });
      return json(res, 200, summaries);
    }

    const uid = userOf(req);
    if (!uid) return json(res, 401, { message: "auth required" });

    if (fn === "create_room_with_invite") {
      if (!body.p_invite_token || body.p_invite_token.length < 16) return json(res, 400, { message: "invalid invite" });
      rooms.set(body.p_room_id, {
        id: body.p_room_id, owner_user_id: uid, title: body.p_title || "未命名文宣",
        room_mode: "single",
        invite_hash: sha(body.p_invite_token), created_at: now(), updated_at: now(),
      });
      members.set(body.p_room_id, new Set([uid]));
      memberRoles.set(roleKey(body.p_room_id, uid), "owner");
      return json(res, 200, body.p_room_id);
    }
    if (fn === "join_room_by_invite") {
      const room = rooms.get(body.p_room_id);
      // Same generic error as the real RPC: never disclose that a room exists.
      if (!room || room.invite_hash !== sha(body.p_invite_token || "")) return json(res, 400, { message: "invalid invite" });
      members.get(body.p_room_id).add(uid);
      if (!memberRoles.has(roleKey(body.p_room_id, uid))) {
        memberRoles.set(roleKey(body.p_room_id, uid), roles.nextJoinRole);
      }
      return json(res, 200, body.p_room_id);
    }
    if (fn === "room_role") {
      return json(res, 200, memberRoles.get(roleKey(body.p_room_id, uid)) ?? null);
    }
    if (fn === "upsert_visual_proposal") {
      const row = {
        id: body.p_id, room_id: body.p_room_id, version_id: body.p_version_id,
        author_name: body.p_author_name, name: body.p_name, payload: body.p_payload,
        revision: (body.p_expected_revision ?? 0) + 1, created_at: now(),
      };
      const i = tables.visual_proposals.findIndex((r) => r.id === row.id);
      const before = i >= 0 ? tables.visual_proposals[i] : null;
      if (i >= 0) tables.visual_proposals[i] = row; else tables.visual_proposals.push(row);
      // The write lands through an RPC, but the trigger fires either way — the
      // other tab is listening on the table, not on the route.
      emitChange({ table: "visual_proposals", type: before ? "UPDATE" : "INSERT", record: row, oldRecord: before });
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
        if (rooms.has(id) && isMember(id, uid)) {
          const before = { ...rooms.get(id) };
          Object.assign(rooms.get(id), patch, { updated_at: now() });
          emitChange({ table: "rooms", type: "UPDATE", record: rooms.get(id), oldRecord: before });
        }
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
      if (table === "versions" && faults.versionInsert) {
        faults.versionInsert = false;
        return json(res, 500, { message: "injected version metadata failure" });
      }
      const prefer = String(req.headers.prefer || "");
      const upsert = prefer.includes("resolution=merge-duplicates");
      const written = [];
      for (const row of rows) {
        if (!isMember(row.room_id, uid)) return json(res, 403, { message: "not a member" });
        // `user_id uuid not null default auth.uid()`: the client never sends it
        // for reactions / verdicts / progress, so the server has to fill it —
        // and filling it here is also what makes "you can only write your own"
        // testable.
        const filled = { ...row };
        if ("user_id" in (tables[table][0] ?? {}) || CONFLICT_KEYS[table] || table === "video_reactions") {
          if (filled.user_id === undefined && table !== "version_review_briefs") filled.user_id = uid;
        }
        if (filled.user_id !== undefined && filled.user_id !== uid) {
          return json(res, 403, { message: "new row violates row-level security policy" });
        }

        if (table === "video_reactions") {
          const key = reactionDedupeKey({ ...filled, user_id: filled.user_id ?? uid });
          if (tables[table].some((r) => reactionDedupeKey(r) === key)) {
            return json(res, 409, { code: "23505", message: "duplicate key value violates unique constraint" });
          }
        }

        const keys = CONFLICT_KEYS[table];
        const existing = keys ? tables[table].find((r) => keys.every((k) => r[k] === filled[k])) : null;
        if (existing && upsert) {
          const before = { ...existing };
          Object.assign(existing, filled, { updated_at: now() });
          // The progress trigger: a rewind must never lower the high-water mark.
          if (table === "version_review_progress") {
            existing.max_watched_seconds = Math.max(
              Number(before.max_watched_seconds) || 0,
              Number(filled.max_watched_seconds) || 0,
            );
            existing.completed_at = before.completed_at ?? filled.completed_at ?? null;
          }
          written.push(existing);
          emitChange({ table, type: "UPDATE", record: existing, oldRecord: before });
          continue;
        }
        if (existing && !upsert) return json(res, 409, { code: "23505", message: "duplicate key value" });
        if (tables[table].some((r) => r.id !== undefined && r.id === filled.id)) {
          return json(res, 409, { code: "23505", message: "duplicate key value" });
        }
        const stored = {
          id: filled.id ?? randomUUID(),
          created_at: now(),
          updated_at: now(),
          ...filled,
          user_id: filled.user_id ?? (table === "version_review_briefs" ? undefined : uid),
        };
        if (table === "comments") applyCommentStatus(stored, null);
        tables[table].push(stored);
        written.push(stored);
        emitChange({ table, type: "INSERT", record: stored });
      }
      if (prefer.includes("return=representation")) return respondRows(req, res, written);
      cors(res); res.writeHead(201); return res.end("[]");
    }
    if (req.method === "PATCH") {
      const patch = JSON.parse((await readBody(req)).toString() || "{}");
      const rows = filterRows(tables[table], url.searchParams).filter((r) => isMember(r.room_id, uid));
      // Only the row's owner may edit their own verdict / progress, exactly as
      // the RLS policies say.
      if (["version_verdicts", "version_review_progress", "video_reactions"].includes(table)) {
        if (rows.some((r) => r.user_id !== uid)) {
          return json(res, 403, { message: "new row violates row-level security policy" });
        }
      }
      // `updated_at` moves on every write, exactly like the SQL trigger — the
      // client derives its cache-busting `?v=` from it.
      for (const row of rows) {
        const before = { ...row };
        Object.assign(row, patch, { updated_at: now() });
        if (table === "comments") applyCommentStatus(row, before);
        emitChange({ table, type: "UPDATE", record: row, oldRecord: before });
      }
      if (String(req.headers.prefer || "").includes("return=representation")) return respondRows(req, res, rows);
      cors(res); res.writeHead(204); return res.end();
    }
    if (req.method === "DELETE") {
      await readBody(req);
      // The rows really do go away now that subscribers hear about it: a tab
      // that heals a missed event by re-reading the table must not find the row
      // it was just told had been deleted.
      const doomed = filterRows(tables[table], url.searchParams).filter((r) => isMember(r.room_id, uid));
      for (const row of doomed) {
        tables[table].splice(tables[table].indexOf(row), 1);
        emitChange({ table, type: "DELETE", oldRecord: row });
      }
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
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        if (faults.sign) return json(res, 500, { message: "injected signing failure" });
        const token = randomUUID();
        const ttl = Number(faults.signTtl ?? body.expiresIn ?? 3600);
        signedUrls.set(token, { bucket, path, expiresAt: Date.now() + Math.max(0, ttl) * 1000 });
        return json(res, 200, { signedURL: `/object/sign/${bucket}/${path}?token=${token}` });
      }
      const token = url.searchParams.get("token");
      const signed = token ? signedUrls.get(token) : null;
      if (!signed || signed.bucket !== bucket || signed.path !== path || signed.expiresAt <= Date.now()) {
        return json(res, 403, { message: "signed URL expired or invalid" });
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
      if (bucket === "share-previews" && faults.previewUploadDelayMs > 0) {
        await new Promise((r) => setTimeout(r, faults.previewUploadDelayMs));
      }
      // A video upload failing mid-flight is the case that decides whether a
      // retry reuses the room it already created or quietly makes a second one.
      if (bucket === "room-assets" && faults.videoUpload && path.includes("/videos/")) {
        return json(res, 500, { message: "injected video upload failure" });
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
      if (bucket === "room-assets" && faults.assetDelete > 0) {
        faults.assetDelete -= 1;
        return json(res, 500, { message: "injected room-assets delete failure" });
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

// ---- realtime ----
// supabase-js talks to Realtime over a WebSocket, and a browser will not fake
// one: with no socket at all `supabase.channel(...)` never reaches SUBSCRIBED,
// so a run can only ever prove what a single tab does to itself. The whole
// point of the cloud room is the other tab, hence the ~200 lines below — the
// slice of RFC6455 a browser actually uses (handshake, client-masked text
// frames, ping/pong) plus the slice of Phoenix v2 that supabase-js expects.
// No `ws` dependency: this mock is test-only, and the parser is small enough
// that owning it beats owning a dependency.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC6455's fixed accept-key salt
const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/** Live sockets: `{ socket, topics: Map<topic, { joinRef, room, configs, presenceKey, presence }> }`. */
const realtimeClients = new Set();

/** Realtime gives each requested change a numeric id and echoes it on every event. */
let configSeq = 0;

function encodeFrame(opcode, payload) {
  const len = payload.length;
  const header = Buffer.alloc(len < 126 ? 2 : len <= 0xffff ? 4 : 10);
  header[0] = 0x80 | opcode; // FIN: the mock never fragments what it sends.
  if (len < 126) header[1] = len;
  else if (len <= 0xffff) { header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/**
 * Pull one frame off the head of `buf`, or `null` while bytes are still in
 * flight — TCP hands us arbitrary chunks, so a frame can straddle two `data`
 * events (and two frames can share one).
 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    // A 64-bit length means a payload past 64KiB. Nothing the app sends comes
    // close, and buffering one would let a runaway test eat the heap.
    return { oversized: true };
  }
  const maskAt = off;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (masked) {
    // Browsers always mask. Unmask into a copy so `buf` stays intact for the
    // frames that follow it in the same chunk.
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ buf[maskAt + (i & 3)];
    payload = out;
  }
  return { opcode, payload, size: off + len };
}

function sendFrame(socket, opcode, payload) {
  if (!socket.writable) return;
  socket.write(encodeFrame(opcode, payload));
}

/** Phoenix v2 frames a message as the positional array `[join_ref, ref, topic, event, payload]`. */
function pushMessage(client, message) {
  if (process.env.MOCK_LOG) console.log("ws ->", message[3], message[2]);
  sendFrame(client.socket, OPCODE.text, Buffer.from(JSON.stringify(message)));
}

function closeClient(client, code) {
  const reason = Buffer.alloc(2);
  reason.writeUInt16BE(code);
  sendFrame(client.socket, OPCODE.close, reason);
  client.socket.end();
  realtimeClients.delete(client);
}

/** `realtime:room:<uuid>` — the only channel name the app opens (see subscribeRoom). */
function roomOfTopic(topic) {
  const m = /^realtime:room:(.+)$/.exec(String(topic ?? ""));
  return m ? m[1] : null;
}

/**
 * Which room a row belongs to. `rooms` is the odd one out: it has no
 * `room_id`, and the app subscribes to it with `id=eq.<roomId>`.
 */
function roomOfRow(table, row) {
  if (!row) return null;
  return row.room_id ?? (table === "rooms" ? row.id : null);
}

/** `room_id=eq.<uuid>` / `id=eq.<uuid>` — the only filter forms subscribeRoom uses. */
function matchesFilter(filter, row) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.*)$/.exec(String(filter ?? ""));
  if (!m) return true; // No filter, or one this mock does not model — deliver rather than silently drop.
  return String(row?.[m[1]]) === m[2];
}

/** Presence as Phoenix sends it: `{ <key>: { metas: [...] } }`, one meta per tab. */
function presenceStateOf(topic) {
  const state = {};
  for (const client of realtimeClients) {
    const sub = client.topics.get(topic);
    if (!sub?.presence) continue;
    const key = sub.presenceKey ?? sub.presence.phx_ref;
    (state[key] ??= { metas: [] }).metas.push(sub.presence);
  }
  return state;
}

/**
 * Push the whole presence state to everyone on the topic. Real Realtime sends
 * diffs; a full state is what the client applies on join anyway, and it keeps
 * the mock from having to track who already knows what.
 */
function syncPresence(topic) {
  for (const client of realtimeClients) {
    if (client.topics.has(topic)) pushMessage(client, [null, null, topic, "presence_state", presenceStateOf(topic)]);
  }
}

function joinTopic(client, joinRef, ref, topic, payload) {
  // Echo the requested changes back verbatim, only adding `id`: supabase-js
  // compares the reply field-by-field against its own bindings and errors the
  // whole channel on the first mismatch, so echoing is the only safe answer.
  const configs = (payload?.config?.postgres_changes ?? []).map((c) => ({ ...c, id: ++configSeq }));
  client.topics.set(topic, {
    joinRef: joinRef ?? null,
    room: roomOfTopic(topic),
    configs,
    presenceKey: payload?.config?.presence?.key ?? null,
    presence: null,
  });
  pushMessage(client, [joinRef ?? null, ref ?? null, topic, "phx_reply", { status: "ok", response: { postgres_changes: configs } }]);
  // supabase-js versions before the bindings check reported SUBSCRIBED only on
  // this message; newer ones ignore it. Sending it costs nothing and keeps the
  // mock working across a client bump.
  pushMessage(client, [null, null, topic, "system", { status: "ok", extension: "postgres_changes", message: "Subscribed to PostgreSQL" }]);
  pushMessage(client, [null, null, topic, "presence_state", presenceStateOf(topic)]);
}

function handleRealtimeMessage(client, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(msg)) return; // vsn=1.0.0 object frames — the app never asks for them.
  const [joinRef, ref, topic, event, payload] = msg;
  if (process.env.MOCK_LOG) console.log("ws <-", event, topic);

  // Unanswered heartbeats make the client close the socket itself, which would
  // look exactly like a mock that dropped the connection.
  if (topic === "phoenix" && event === "heartbeat") {
    return pushMessage(client, [joinRef ?? null, ref ?? null, topic, "phx_reply", { status: "ok", response: {} }]);
  }
  if (event === "phx_join") return joinTopic(client, joinRef, ref, topic, payload);
  if (event === "phx_leave") {
    client.topics.delete(topic);
    pushMessage(client, [joinRef ?? null, ref ?? null, topic, "phx_reply", { status: "ok", response: {} }]);
    return syncPresence(topic);
  }
  if (event === "presence") {
    const sub = client.topics.get(topic);
    if (sub && payload?.event === "track") sub.presence = { phx_ref: randomUUID(), ...(payload.payload ?? {}) };
    if (sub && payload?.event === "untrack") sub.presence = null;
    if (ref) pushMessage(client, [joinRef ?? null, ref, topic, "phx_reply", { status: "ok", response: {} }]);
    return syncPresence(topic);
  }
  // Anything else that carries a ref (e.g. `access_token` after a refresh) gets
  // an ack, so the client's push resolves instead of sitting out its timeout.
  if (ref) pushMessage(client, [joinRef ?? null, ref, topic, "phx_reply", { status: "ok", response: {} }]);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, mockOrigin);
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/realtime/v1/websocket" || !key) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  requestLog.push(`WS ${url.pathname}`);
  socket.setNoDelay(true);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${createHash("sha1").update(key + WS_GUID).digest("base64")}\r\n\r\n`,
  );

  const client = { socket, topics: new Map() };
  realtimeClients.add(client);

  let buf = Buffer.alloc(0);
  const pump = () => {
    for (;;) {
      const frame = decodeFrame(buf);
      if (!frame) return;
      if (frame.oversized) return closeClient(client, 1009);
      buf = buf.subarray(frame.size);
      if (frame.opcode === OPCODE.text) handleRealtimeMessage(client, frame.payload.toString("utf8"));
      else if (frame.opcode === OPCODE.ping) sendFrame(socket, OPCODE.pong, frame.payload);
      else if (frame.opcode === OPCODE.close) return closeClient(client, 1000);
      else if (frame.opcode === OPCODE.binary || frame.opcode === OPCODE.continuation) return closeClient(client, 1003);
      // pong: nothing to do, the mock never pings.
    }
  };
  socket.on("data", (chunk) => { buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; pump(); });
  socket.on("error", () => { realtimeClients.delete(client); socket.destroy(); });
  socket.on("close", () => {
    const topics = [...client.topics.keys()];
    realtimeClients.delete(client);
    // The tab is gone; everyone else's online count has to notice.
    for (const topic of topics) syncPresence(topic);
  });
  if (head?.length) { buf = Buffer.from(head); pump(); } // the first frame can ride along with the handshake
});

/**
 * Fan a row change out to every subscriber of the row's room, in the shape
 * Realtime puts on the wire. Called from the table handlers below, so a test
 * only has to write through the normal API to make the other tab move.
 */
export function emitChange({ schema = "public", table, type, record, oldRecord }) {
  const room = roomOfRow(table, record) ?? roomOfRow(table, oldRecord);
  if (!room) return;
  const data = {
    schema,
    table,
    commit_timestamp: now(),
    // Two spellings on purpose: realtime-js reads `type` + `record`/
    // `old_record` (it lowercases `type` to pick bindings and rebuilds
    // `new`/`old` itself, and throws outright if `type` is missing), while
    // `eventType`/`new`/`old` are the enriched names a handler ends up seeing.
    type,
    eventType: type,
    record: record ?? {},
    old_record: oldRecord ?? {},
    new: record ?? {},
    old: oldRecord ?? {},
    // Empty `columns` makes the client's type conversion a pass-through, which
    // is what we want: the mock stores JS values, not Postgres text.
    columns: [],
    errors: null,
  };
  // NOTE: `old` here carries the whole previous row (REPLICA IDENTITY FULL).
  // Real Postgres only guarantees the primary key, so an assertion that leans
  // on any other `old` column would pass here and fail in production.
  const subject = type === "DELETE" ? data.old_record : data.record;
  for (const client of realtimeClients) {
    for (const [topic, sub] of client.topics) {
      if (sub.room !== room) continue;
      const ids = sub.configs
        .filter((c) => c.table === table
          && (!c.schema || c.schema === "*" || c.schema === schema)
          && (c.event === "*" || c.event === type)
          && matchesFilter(c.filter, subject))
        .map((c) => c.id);
      if (ids.length) pushMessage(client, [null, null, topic, "postgres_changes", { ids, data }]);
    }
  }
}

/** Drop every realtime socket. Exported so a run can cut the cord mid-test. */
export function closeRealtime() {
  for (const client of [...realtimeClients]) {
    realtimeClients.delete(client);
    client.socket.destroy();
  }
}

// `server.close()` resolves only once the last connection is gone, and an
// upgraded socket never ends by itself — a run that finished asserting would
// hang on teardown. Wrapping close keeps every existing caller unchanged.
const closeHttpServer = server.close.bind(server);
server.close = (cb) => { closeRealtime(); return closeHttpServer(cb); };

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
