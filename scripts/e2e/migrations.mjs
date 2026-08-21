#!/usr/bin/env node
/**
 * Applies `supabase/migrations/*.sql` to a throwaway PostgreSQL cluster and
 * then probes the rules they are supposed to enforce.
 *
 * Migrations are the one part of this repo that cannot be checked by `tsc` or
 * by the browser suites, and PR #21 adds a table, a policy set, an anon-facing
 * RPC and a public bucket to a schema whose whole job is keeping rooms private.
 * So this run does not just check that the SQL parses — it logs in as a member,
 * as a stranger and as anon, and asserts who can see what.
 *
 *   npm run test:migrations
 *
 * Needs the PostgreSQL binaries (initdb/pg_ctl/psql); skips with a notice when
 * they are absent. `supabase-shim.sql` stands in for the Supabase-provided
 * pieces (auth, storage, roles) and is never applied to a real project.
 *
 * PostgreSQL refuses to run as root, so under root (containers, CI images) the
 * cluster is run as the `postgres` system account instead.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, chownSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const SHIM = join(dirname(fileURLToPath(import.meta.url)), "supabase-shim.sql");
const PORT = 55432;

const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

/**
 * Where to find a throwaway PostgreSQL. PG_BIN wins, so a developer can point
 * this at any local build (including an unpacked portable one) without
 * installing anything system-wide.
 */
const PG_CANDIDATES = [
  process.env.PG_BIN,
  "/usr/lib/postgresql/16/bin",
  "/usr/lib/postgresql/15/bin",
  "/usr/local/pgsql/bin",
  "C:/Program Files/PostgreSQL/16/bin",
  "C:/Program Files/PostgreSQL/15/bin",
  "D:/pgsql-dl/x/pgsql/bin",
  "D:/pgsql/bin",
].filter(Boolean);

const PG_BIN = PG_CANDIDATES.find((d) => existsSync(join(d, `initdb${EXE}`)));
if (!PG_BIN) {
  // 在開發者機器上「找不到 Postgres 就跳過」是體貼；在 release gate 上那叫假綠。
  // 這支測試是 RLS 與房間能力規則唯一的守門員，靜默 exit 0 會讓一條「檢視者
  // 可以刪別人版本」的 migration 一路通過 CI。CI 請設 REQUIRE_PG=1。
  console.log("找不到 PostgreSQL 執行檔（initdb / pg_ctl）。設定 PG_BIN 可指定路徑。");
  if (process.env.REQUIRE_PG === "1") {
    console.error("REQUIRE_PG=1：migration 測試是 release gate，不能因為缺少資料庫就算通過。");
    process.exit(1);
  }
  console.log("略過（本機開發模式）。");
  process.exit(0);
}
const bin = (name) => join(PG_BIN, `${name}${EXE}`);

let failures = 0;
let checks = 0;
const ok = (label, condition, detail = "") => {
  checks += 1;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (name) => console.log(`\n${name}`);

const dataDir = mkdtempSync(join(tmpdir(), "duigao-pg-"));
const sock = mkdtempSync(join(tmpdir(), "duigao-sock-"));

/** Under root, hand the cluster to an unprivileged account (postgres, else nobody). */
function unprivileged() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  for (const name of ["postgres", "nobody"]) {
    const line = spawnSync("getent", ["passwd", name], { encoding: "utf8" }).stdout ?? "";
    const [, , uid, gid] = line.trim().split(":");
    if (uid) return { name, uid: Number(uid), gid: Number(gid) };
  }
  return null;
}
const asUser = unprivileged();
if (asUser) {
  chownSync(dataDir, asUser.uid, asUser.gid);
  chownSync(sock, asUser.uid, asUser.gid);
}
const PG_USER = asUser?.name ?? process.env.USER ?? process.env.USERNAME ?? "postgres";
const spawnOpts = asUser ? { uid: asUser.uid, gid: asUser.gid } : {};
// Windows has no unix sockets, so the cluster listens on loopback there. The
// port is still private to this run and the cluster is deleted at the end.
const PGHOST = IS_WINDOWS ? "127.0.0.1" : sock;
// No quotes on Windows: the value reaches postgres verbatim (there is no shell
// to strip them), and a quoted address is not an address.
const LISTEN = IS_WINDOWS
  ? `-p ${PORT} -c listen_addresses=127.0.0.1`
  : `-p ${PORT} -k ${sock} -c listen_addresses=''`;
const env = {
  ...process.env,
  PGHOST,
  PGPORT: String(PORT),
  PGDATABASE: "duigao",
  PGUSER: PG_USER,
  HOME: sock,
  PGCLIENTENCODING: "UTF8",
};

function psql(sql, { expectError = false } = {}) {
  // The statement travels as a UTF-8 FILE rather than a -c argument: on Windows
  // psql reads command-line arguments in the console codepage, which turns the
  // Chinese in these fixtures into invalid byte sequences before the server
  // ever sees them. A file has an encoding; an argv string does not.
  const scratch = join(dataDir, "stmt.sql");
  writeFileSync(scratch, sql, "utf8");
  const res = spawnSync(bin("psql"), ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t", "-f", scratch], {
    env,
    encoding: "utf8",
    ...spawnOpts,
  });
  if (res.status !== 0 && !expectError) {
    throw new Error(`psql failed:\n${sql}\n${res.stderr}`);
  }
  return { out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim(), failed: res.status !== 0 };
}

function psqlFile(file) {
  const res = spawnSync(bin("psql"), ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-f", file], {
    env,
    encoding: "utf8",
    ...spawnOpts,
  });
  if (res.status !== 0) throw new Error(`applying ${file} failed:\n${res.stderr}`);
  return res.stdout;
}

let started = false;
try {
  execFileSync(bin("initdb"), ["-D", dataDir, "-U", PG_USER, "--auth=trust", "-E", "UTF8"], {
    stdio: "pipe",
    env,
    ...spawnOpts,
  });
  // `stdio: "ignore"` matters on Windows: pg_ctl hands its stdio handles to the
  // server it spawns, so a piped start never returns — the parent waits on a
  // pipe the (still running) database keeps open.
  execFileSync(
    bin("pg_ctl"),
    ["-D", dataDir, "-o", LISTEN, "-w", "-l", join(dataDir, "log"), "start"],
    { stdio: "ignore", env, ...spawnOpts },
  );
  started = true;
  execFileSync(bin("createdb"), ["duigao"], { env, stdio: "pipe", ...spawnOpts });

  section("套用 migrations");
  psqlFile(SHIM);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    psqlFile(join(MIGRATIONS, f));
    ok(`${f} 套用成功`, true);
  }
  // A migration set that cannot be re-run is a migration set nobody dares
  // re-run. 0005 is written to be idempotent; prove it.
  psqlFile(join(MIGRATIONS, "0005_share_previews.sql"));
  ok("0005 可以重複套用（idempotent）", true);
  const shapeQuery = `select
      (select count(*) from information_schema.columns where table_name in ('rooms','versions','comments')) || '/' ||
      (select count(*) from pg_constraint where conname like 'comments_anchor%' or conname like 'versions_media%'
         or conname like 'rooms_media%' or conname like 'versions_duration%') || '/' ||
      (select count(*) from pg_indexes where indexname = 'idx_comments_version_time') || '/' ||
      (select count(*) from pg_trigger where tgname = 'comments_derive_anchor');`;
  const shapeBefore = psql(shapeQuery).out;
  psqlFile(join(MIGRATIONS, "0006_video_rooms.sql"));
  const shapeAfter = psql(shapeQuery).out;
  // Not just "it did not throw": re-applying must leave the same columns,
  // constraints, index and trigger — a migration that doubles anything on a
  // second run is a migration nobody can safely re-run.
  ok("0006 可以重複套用，且結構完全一樣", shapeBefore === shapeAfter, `${shapeBefore} → ${shapeAfter}`);

  // ------------------------------------------------------------- fixtures
  const owner = psql("insert into auth.users default values returning id;").out;
  const stranger = psql("insert into auth.users default values returning id;").out;
  // Negative cases are the point here, so these never throw: callers read
  // `.failed` / `.out` and assert on it.
  const as = (uid, sql) =>
    psql(`set role authenticated; set request.jwt.claim.sub = '${uid}'; ${sql}`, { expectError: true });
  const asAnon = (sql) => psql(`set role anon; set request.jwt.claim.sub = ''; ${sql}`, { expectError: true });

  const roomId = psql("select gen_random_uuid();").out;
  const versionId = psql("select gen_random_uuid();").out;
  psql(
    `set request.jwt.claim.sub = '${owner}';
     select create_room_with_invite('${roomId}'::uuid, '期初演講討論', 'a-very-long-invite-token-value', '主辦方', '#c45c4a');
     insert into public.versions (id, room_id, label, sort_order, image_path, mime_type)
       values ('${versionId}'::uuid, '${roomId}'::uuid, '初稿', 0, 'rooms/${roomId}/versions/${versionId}/poster.png', 'image/png');`,
  );

  section("share_previews：只有成員能建立 / 修改");
  const previewId = psql("select gen_random_uuid();").out;
  const insertSql = `insert into public.share_previews (id, room_id, version_id, title, description)
     values ('${previewId}'::uuid, '${roomId}'::uuid, '${versionId}'::uuid, '期初演講討論', '幫我看一下這張文宣');`;
  ok("成員可以建立 preview", !as(owner, insertSql).failed);
  ok("非成員不能建立 preview", as(stranger, insertSql.replace(previewId, psql("select gen_random_uuid();").out)).failed);
  ok(
    "非成員讀不到 preview 這一列",
    as(stranger, `select count(*) from public.share_previews;`).out === "0",
  );
  ok("成員讀得到自己的 preview", as(owner, `select count(*) from public.share_previews;`).out === "1");
  // An UPDATE the policy hides simply matches no rows, so the proof is that the
  // owner's row is untouched afterwards.
  as(stranger, `update public.share_previews set enabled = false where id = '${previewId}'::uuid;`);
  ok(
    "非成員停用不了別人的 preview",
    as(owner, `select enabled from public.share_previews where id = '${previewId}'::uuid;`).out === "t",
  );

  section("share_previews：version 必須屬於同一個房間");
  {
    const otherRoom = psql("select gen_random_uuid();").out;
    const otherVersion = psql("select gen_random_uuid();").out;
    psql(
      `set request.jwt.claim.sub = '${stranger}';
       select create_room_with_invite('${otherRoom}'::uuid, '別人的文宣', 'another-very-long-invite-token', '別人', '#3d6b8c');
       insert into public.versions (id, room_id, label, sort_order, image_path, mime_type)
         values ('${otherVersion}'::uuid, '${otherRoom}'::uuid, '初稿', 0, 'p.png', 'image/png');`,
    );
    const crossed = as(
      owner,
      `insert into public.share_previews (room_id, version_id, title, description)
         values ('${roomId}'::uuid, '${otherVersion}'::uuid, 'x', 'y');`,
    );
    ok("不能用別的房間的 version 建 preview", crossed.failed, crossed.err.split("\n")[0]);
  }

  section("get_share_preview：匿名可讀，但只讀得到卡片欄位");
  {
    const cols = psql(
      `select string_agg(p.proargnames[i], ',' order by i)
       from pg_proc p, generate_series(1, array_length(p.proargnames, 1)) i
       where p.proname = 'get_share_preview' and p.proargmodes[i] = 't';`,
    ).out;
    ok("回傳欄位就是 title/description/image_path/updated_at", cols === "title,description,image_path,updated_at", cols);

    const anonRead = asAnon(`select title, image_path from public.get_share_preview('${previewId}'::uuid);`);
    ok("匿名讀得到 title", anonRead.out.startsWith("期初演講討論"), anonRead.out || anonRead.err);
    ok("匿名直接查表被 RLS 擋下", asAnon(`select count(*) from public.share_previews;`).out !== "1");
    ok(
      "匿名讀不到 comments / messages / visual_proposals",
      ["comments", "messages", "visual_proposals"].every(
        (t) => asAnon(`select count(*) from public.${t};`).out !== "1",
      ),
    );

    as(owner, `update public.share_previews set thumbnail_path = '${previewId}/cover.webp' where id = '${previewId}'::uuid;`);
    ok(
      "show_thumbnail = true 時回傳縮圖路徑",
      asAnon(`select image_path from public.get_share_preview('${previewId}'::uuid);`).out === `${previewId}/cover.webp`,
    );
    as(owner, `update public.share_previews set show_thumbnail = false where id = '${previewId}'::uuid;`);
    ok(
      "關閉縮圖後 image_path 是 null",
      asAnon(`select coalesce(image_path, 'NULL') from public.get_share_preview('${previewId}'::uuid);`).out === "NULL",
    );
    as(owner, `update public.share_previews set show_thumbnail = true, enabled = false where id = '${previewId}'::uuid;`);
    ok(
      "停用後完全查不到",
      asAnon(`select count(*) from public.get_share_preview('${previewId}'::uuid);`).out === "0",
    );
    as(owner, `update public.share_previews set enabled = true where id = '${previewId}'::uuid;`);
    ok(
      "猜 room id 也拿不到 preview（previewId 才是鑰匙）",
      asAnon(`select count(*) from public.get_share_preview('${roomId}'::uuid);`).out === "0",
    );
  }

  section("updated_at trigger：每次寫入都會前進（cache busting）");
  {
    const before = as(owner, `select updated_at from public.share_previews where id = '${previewId}'::uuid;`).out;
    psql("select pg_sleep(0.05);");
    as(owner, `update public.share_previews set title = '期初演講討論（改）' where id = '${previewId}'::uuid;`);
    const after = as(owner, `select updated_at from public.share_previews where id = '${previewId}'::uuid;`).out;
    ok("updated_at 有前進", before !== after, `${before} → ${after}`);
  }

  section("Storage buckets：room-assets 私有、share-previews 公開");
  {
    ok("room-assets 仍然是私有", psql("select public from storage.buckets where id = 'room-assets';").out === "f");
    ok("share-previews 是公開的衍生縮圖 bucket", psql("select public from storage.buckets where id = 'share-previews';").out === "t");
    ok(
      "share-previews 的 SELECT policy 是 member-scoped（讓成員刪得掉自己的圖）",
      psql("select qual from pg_policies where tablename = 'objects' and policyname = 'share_previews_select';").out.includes("is_room_member"),
    );
    const thumb = `insert into storage.objects (bucket_id, name) values ('share-previews', '${previewId}/cover.webp');`;
    ok("成員可以上傳自己 preview 的縮圖", !as(owner, thumb).failed);
    ok(
      "非成員不能覆蓋別人 preview 的縮圖",
      as(stranger, `insert into storage.objects (bucket_id, name) values ('share-previews', '${previewId}/evil.webp');`).failed,
    );
    // Revocation is only real if the bytes can actually be removed. PostgreSQL
    // applies SELECT policies when a DELETE inspects columns, so a bucket with
    // only INSERT/UPDATE/DELETE policies silently deletes nothing.
    as(owner, `delete from storage.objects where bucket_id = 'share-previews' and name = '${previewId}/cover.webp';`);
    ok(
      "成員可以刪掉自己 preview 的縮圖（撤銷要真的刪得掉）",
      psql(`select count(*) from storage.objects where name = '${previewId}/cover.webp';`).out === "0",
    );
    ok(
      "匿名仍然無法列舉 share-previews bucket",
      asAnon(`select count(*) from storage.objects where bucket_id = 'share-previews';`).out !== "1",
    );
  }

  section("影片房：rooms.media_type 與舊房間相容");
  {
    ok(
      "舊房間自動是 image（欄位有 default）",
      psql(`select media_type from public.rooms where id = '${roomId}'::uuid;`).out === "image",
    );
    ok(
      "media_type 只收 image / video",
      as(owner, `update public.rooms set media_type = 'audio' where id = '${roomId}'::uuid;`).failed,
    );
    ok(
      "成員可以把房間改成 video",
      !as(owner, `update public.rooms set media_type = 'video' where id = '${roomId}'::uuid;`).failed,
    );
    psql(`update public.rooms set media_type = 'image' where id = '${roomId}'::uuid;`);
  }

  section("影片版本：versions 擴充欄位與完整性");
  const videoVersionId = psql("select gen_random_uuid();").out;
  {
    const insertVideo = `insert into public.versions
        (id, room_id, label, sort_order, media_kind, image_path, video_path, mime_type, duration_seconds, file_size)
      values ('${videoVersionId}'::uuid, '${roomId}'::uuid, '初剪', 1, 'video',
        'rooms/${roomId}/versions/${videoVersionId}/poster.jpg',
        'rooms/${roomId}/videos/${videoVersionId}/original.mp4', 'video/mp4', 84.5, 12345678);`;
    ok("成員可以新增影片版本", !as(owner, insertVideo).failed);

    const noVideoPath = psql("select gen_random_uuid();").out;
    ok(
      "video 版本缺 video_path 會被擋下",
      as(
        owner,
        `insert into public.versions (id, room_id, label, sort_order, media_kind, image_path)
         values ('${noVideoPath}'::uuid, '${roomId}'::uuid, '壞的', 9, 'video', 'rooms/x/poster.jpg');`,
      ).failed,
    );

    const noImagePath = psql("select gen_random_uuid();").out;
    ok(
      "image 版本缺 image_path 會被擋下",
      as(
        owner,
        `insert into public.versions (id, room_id, label, sort_order, media_kind)
         values ('${noImagePath}'::uuid, '${roomId}'::uuid, '壞的', 9, 'image');`,
      ).failed,
    );

    const zeroDuration = psql("select gen_random_uuid();").out;
    ok(
      "duration 0 會被擋下（讀不到長度要寫 NULL）",
      as(
        owner,
        `insert into public.versions (id, room_id, label, sort_order, media_kind, video_path, duration_seconds)
         values ('${zeroDuration}'::uuid, '${roomId}'::uuid, '壞的', 9, 'video', 'rooms/x/v.mp4', 0);`,
      ).failed,
    );

    const nullDuration = psql("select gen_random_uuid();").out;
    ok(
      "duration 讀不到時寫 NULL 是允許的",
      !as(
        owner,
        `insert into public.versions (id, room_id, label, sort_order, media_kind, video_path)
         values ('${nullDuration}'::uuid, '${roomId}'::uuid, '長度未知', 8, 'video', 'rooms/x/v2.mp4');`,
      ).failed,
    );
    psql(`delete from public.versions where id = '${nullDuration}'::uuid;`);

    ok(
      "非成員仍讀不到影片版本的 video_path",
      as(stranger, `select count(*) from public.versions where id = '${videoVersionId}'::uuid;`).out === "0",
    );
  }

  section("時間錨點：comments 新欄位與舊資料相容");
  {
    // The exact shape an older client still writes: no anchor_type, no times.
    const legacyPoint = psql("select gen_random_uuid();").out;
    ok(
      "舊前端的點評（不帶 anchor_type）仍然寫得進去",
      !as(
        owner,
        `insert into public.comments (id, room_id, version_id, author_name, x, y, body)
         values ('${legacyPoint}'::uuid, '${roomId}'::uuid, '${versionId}'::uuid, '夥伴', 0.4, 0.6, '這裡看不清楚');`,
      ).failed,
    );
    ok(
      "它會被記成 image-point",
      psql(`select anchor_type from public.comments where id = '${legacyPoint}'::uuid;`).out === "image-point",
    );

    const legacyRegion = psql("select gen_random_uuid();").out;
    ok(
      "舊前端的圈範圍（帶 region、不帶 anchor_type）仍然寫得進去",
      !as(
        owner,
        `insert into public.comments (id, room_id, version_id, author_name, x, y, region, body)
         values ('${legacyRegion}'::uuid, '${roomId}'::uuid, '${versionId}'::uuid, '夥伴', 0.5, 0.5,
                 '{"x":0.1,"y":0.1,"width":0.3,"height":0.2}'::jsonb, '這一塊要調整');`,
      ).failed,
    );
    ok(
      "trigger 會把它導正成 image-region",
      psql(`select anchor_type from public.comments where id = '${legacyRegion}'::uuid;`).out === "image-region",
    );

    const pointId = psql("select gen_random_uuid();").out;
    ok(
      "影片時間點留言",
      !as(
        owner,
        `insert into public.comments (id, room_id, version_id, author_name, anchor_type, time_seconds, body)
         values ('${pointId}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '夥伴', 'video-point', 13.42, '字幕出現太慢');`,
      ).failed,
    );

    const rangeId = psql("select gen_random_uuid();").out;
    ok(
      "影片片段留言",
      !as(
        owner,
        `insert into public.comments (id, room_id, version_id, author_name, anchor_type, time_seconds, end_time_seconds, body)
         values ('${rangeId}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '夥伴', 'video-range', 22, 27.5, '這段轉場太突然');`,
      ).failed,
    );

    const badRange = psql("select gen_random_uuid();").out;
    ok(
      "end 小於等於 start 的片段會被擋下",
      as(
        owner,
        `insert into public.comments (id, room_id, version_id, author_name, anchor_type, time_seconds, end_time_seconds, body)
         values ('${badRange}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '夥伴', 'video-range', 27, 22, '反過來的');`,
      ).failed,
    );

    const noTime = psql("select gen_random_uuid();").out;
    ok(
      "影片錨點沒有時間會被擋下",
      as(
        owner,
        `insert into public.comments (id, room_id, version_id, author_name, anchor_type, body)
         values ('${noTime}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '夥伴', 'video-point', '沒有時間');`,
      ).failed,
    );

    const timedImage = psql("select gen_random_uuid();").out;
    ok(
      "圖片錨點帶時間會被擋下",
      as(
        owner,
        `insert into public.comments (id, room_id, version_id, author_name, anchor_type, time_seconds, body)
         values ('${timedImage}'::uuid, '${roomId}'::uuid, '${versionId}'::uuid, '夥伴', 'image-point', 5, '不該有時間');`,
      ).failed,
    );

    const equalRange = psql("select gen_random_uuid();").out;
    ok(
      "end 等於 start 的片段也會被擋下（那是一個瞬間，不是一段）",
      as(
        owner,
        `insert into public.comments (id, room_id, version_id, author_name, anchor_type, time_seconds, end_time_seconds, body)
         values ('${equalRange}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '夥伴', 'video-range', 22, 22, '同一點');`,
      ).failed,
    );

    ok(
      "非成員讀不到影片留言的時間",
      as(stranger, `select count(*) from public.comments where version_id = '${videoVersionId}'::uuid;`).out === "0",
    );
  }

  section("影片沒有動到既有的分享安全面");
  {
    // The composite (version_id, room_id) foreign key predates video; a share
    // card for a video room points at a video version, so that pairing has to
    // hold for one of those too.
    const videoPreviewId = psql("select gen_random_uuid();").out;
    // One live preview per room (idx_share_previews_room_enabled, PR #21), so
    // the earlier image preview has to step down first — otherwise this probe
    // would be testing that unique index instead of the composite foreign key
    // it exists to test.
    psql(`update public.share_previews set enabled = false where room_id = '${roomId}'::uuid;`);
    ok(
      "share_previews 可以指向一支影片版本",
      !as(
        owner,
        `insert into public.share_previews (id, room_id, version_id, title, description)
         values ('${videoPreviewId}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '影片對稿', '幫我看一下這支影片');`,
      ).failed,
    );
    psql(`delete from public.share_previews where id = '${videoPreviewId}'::uuid;`);

    ok(
      "get_share_preview 的輸出欄位沒有變（沒有 media_type、沒有 room_id）",
      psql(
        `select array_to_string(p.proargnames, ',') from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'get_share_preview';`,
      ).out === "p_preview_id,title,description,image_path,updated_at",
    );
    ok(
      "room-assets 仍然是私有的（影片也在裡面）",
      psql("select public from storage.buckets where id = 'room-assets';").out === "f",
    );
    ok(
      "room-assets 沒有被鎖成只收特定 mime（會擋掉既有圖片）",
      psql("select allowed_mime_types is null from storage.buckets where id = 'room-assets';").out === "t",
    );
    // The number itself is the contract: the client validates against the same
    // ceiling, and a bucket quietly set to something else would make one of the
    // two lie to the user.
    ok(
      "room-assets 的上限就是 0006 寫的 200MB",
      psql("select coalesce(file_size_limit, 0) from storage.buckets where id = 'room-assets';").out ===
        String(200 * 1024 * 1024),
      psql("select coalesce(file_size_limit, 0) from storage.buckets where id = 'room-assets';").out,
    );
  }

  section("既有規則沒有被動到");
  {
    ok(
      "room-assets 的四條 policy 還在",
      psql("select count(*) from pg_policies where tablename = 'objects' and policyname like 'room_assets_%';").out === "4",
    );
    ok(
      "非成員仍讀不到 rooms",
      as(stranger, `select count(*) from public.rooms where id = '${roomId}'::uuid;`).out === "0",
    );
    ok(
      "非成員仍讀不到 versions",
      as(stranger, `select count(*) from public.versions where room_id = '${roomId}'::uuid;`).out === "0",
    );
  }

  // ------------------------------------------------ capability + archive proofs
  section("Capability model：reviewer / editor / owner");
  const editor = psql("insert into auth.users default values returning id;").out;
  const reviewer = psql("insert into auth.users default values returning id;").out;
  const joiner = psql("insert into auth.users default values returning id;").out;
  const freshJoiner = psql("insert into auth.users default values returning id;").out;
  const capRoom = psql("select gen_random_uuid();").out;
  const capToken = "capability-room-invite-token";
  psql(
    `set request.jwt.claim.sub = '${owner}';
     select create_room_with_invite('${capRoom}'::uuid, 'Capability room', '${capToken}', 'Owner', '#111111');
     insert into public.room_members (room_id, user_id, display_name, color, role)
       values ('${capRoom}'::uuid, '${editor}'::uuid, 'Editor', '#222222', 'editor'),
              ('${capRoom}'::uuid, '${reviewer}'::uuid, 'Reviewer', '#333333', 'reviewer');`,
  );
  const capVersion = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}'; insert into public.versions (id, room_id, label, sort_order, image_path) values ('${capVersion}'::uuid, '${capRoom}'::uuid, 'Capability cut', 0, 'capability.png');`);

  const reviewerVersion = psql("select gen_random_uuid();").out;
  as(reviewer, `insert into public.versions (id, room_id, label, sort_order, image_path) values ('${reviewerVersion}'::uuid, '${capRoom}'::uuid, 'blocked', 2, 'blocked.png');`);
  as(reviewer, `update public.versions set label = 'blocked' where id = '${capVersion}'::uuid;`);
  const reviewerVersionUpdate = as(owner, `select label from public.versions where id = '${capVersion}'::uuid;`).out;
  as(reviewer, `delete from public.versions where id = '${capVersion}'::uuid;`);
  ok("reviewer cannot insert/update/delete versions", reviewerVersionUpdate === "Capability cut" && as(owner, `select count(*) from public.versions where id = '${capVersion}'::uuid;`).out === "1");
  const editorVersion = psql("select gen_random_uuid();").out;
  ok("editor can insert/update/delete versions", !as(editor, `insert into public.versions (id, room_id, label, sort_order, image_path) values ('${editorVersion}'::uuid, '${capRoom}'::uuid, 'editor', 3, 'editor.png');`).failed && !as(editor, `update public.versions set label = 'editor updated' where id = '${editorVersion}'::uuid;`).failed && !as(editor, `delete from public.versions where id = '${editorVersion}'::uuid;`).failed);
  const ownerVersion = psql("select gen_random_uuid();").out;
  ok("owner can insert/update/delete versions", !as(owner, `insert into public.versions (id, room_id, label, sort_order, image_path) values ('${ownerVersion}'::uuid, '${capRoom}'::uuid, 'owner', 4, 'owner.png');`).failed && !as(owner, `update public.versions set label = 'owner updated' where id = '${ownerVersion}'::uuid;`).failed && !as(owner, `delete from public.versions where id = '${ownerVersion}'::uuid;`).failed);

  const reviewerAssetPath = `rooms/${capRoom}/videos/${capVersion}/reviewer.mp4`;
  psql(`insert into storage.objects (bucket_id, name) values ('room-assets', '${reviewerAssetPath}');`);
  as(reviewer, `insert into storage.objects (bucket_id, name) values ('room-assets', 'rooms/${capRoom}/videos/${capVersion}/blocked.mp4');`);
  as(reviewer, `update storage.objects set name = '${reviewerAssetPath}.changed' where bucket_id = 'room-assets' and name = '${reviewerAssetPath}';`);
  as(reviewer, `delete from storage.objects where bucket_id = 'room-assets' and name = '${reviewerAssetPath}';`);
  ok("reviewer cannot insert/update/delete room-assets objects", psql(`select name from storage.objects where bucket_id = 'room-assets' and name = '${reviewerAssetPath}';`).out === reviewerAssetPath && as(reviewer, `select count(*) from storage.objects where bucket_id = 'room-assets' and name = 'rooms/${capRoom}/videos/${capVersion}/blocked.mp4';`).out === "0");
  const editorAssetPath = `rooms/${capRoom}/videos/${capVersion}/editor.mp4`;
  ok("editor can insert/update/delete room-assets objects", !as(editor, `insert into storage.objects (bucket_id, name) values ('room-assets', '${editorAssetPath}');`).failed && !as(editor, `update storage.objects set name = '${editorAssetPath}.changed' where bucket_id = 'room-assets' and name = '${editorAssetPath}';`).failed && !as(editor, `delete from storage.objects where bucket_id = 'room-assets' and name = '${editorAssetPath}.changed';`).failed);
  as(owner, `delete from storage.objects where bucket_id = 'room-assets' and name = '${reviewerAssetPath}';`);
  const ownerAssetPath = `rooms/${capRoom}/versions/${capVersion}/poster.png`;
  ok("owner can write room-assets objects", !as(owner, `insert into storage.objects (bucket_id, name) values ('room-assets', '${ownerAssetPath}');`).failed && !as(owner, `update storage.objects set name = '${ownerAssetPath}.changed' where bucket_id = 'room-assets' and name = '${ownerAssetPath}';`).failed && !as(owner, `delete from storage.objects where bucket_id = 'room-assets' and name = '${ownerAssetPath}.changed';`).failed);

  const capPreview = psql("select gen_random_uuid();").out;
  const previewInsert = `insert into public.share_previews (id, room_id, version_id, title, description) values ('${capPreview}'::uuid, '${capRoom}'::uuid, '${capVersion}'::uuid, 'capability', 'preview');`;
  ok("reviewer cannot create share_previews", as(reviewer, previewInsert).failed);
  ok("owner can create share_previews and reviewer can read it", !as(owner, previewInsert).failed && as(reviewer, `select count(*) from public.share_previews where id = '${capPreview}'::uuid;`).out === "1");
  as(reviewer, `update public.share_previews set title = 'blocked' where id = '${capPreview}'::uuid;`);
  as(reviewer, `delete from public.share_previews where id = '${capPreview}'::uuid;`);
  ok("reviewer cannot modify/delete share_previews", as(owner, `select title, count(*) from public.share_previews where id = '${capPreview}'::uuid group by title;`).out === "capability|1");

  const reviewerComment = psql("select gen_random_uuid();").out;
  const ownerComment = psql("select gen_random_uuid();").out;
  ok("reviewer can insert/update a comment and insert a reply", !as(reviewer, `insert into public.comments (id, room_id, version_id, author_name, body) values ('${reviewerComment}'::uuid, '${capRoom}'::uuid, '${capVersion}'::uuid, 'Reviewer', 'comment');`).failed && !as(reviewer, `update public.comments set resolved = true where id = '${reviewerComment}'::uuid;`).failed && !as(reviewer, `insert into public.comment_replies (id, room_id, comment_id, author_name, body) values (gen_random_uuid(), '${capRoom}'::uuid, '${reviewerComment}'::uuid, 'Reviewer', 'reply');`).failed);
  as(owner, `insert into public.comments (id, room_id, version_id, author_name, body) values ('${ownerComment}'::uuid, '${capRoom}'::uuid, '${capVersion}'::uuid, 'Owner', 'owner comment');`);
  as(reviewer, `delete from public.comments where id = '${ownerComment}'::uuid;`);
  const ownerCommentStillThere = as(owner, `select count(*) from public.comments where id = '${ownerComment}'::uuid;`).out === "1";
  ok("reviewer cannot delete another user's comment but can delete their own", ownerCommentStillThere && !as(reviewer, `delete from public.comments where id = '${reviewerComment}'::uuid;`).failed);
  ok("editor/owner can delete another user's comment", !as(editor, `delete from public.comments where id = '${ownerComment}'::uuid;`).failed);

  as(reviewer, `update public.room_members set role = 'editor' where room_id = '${capRoom}'::uuid and user_id = '${reviewer}'::uuid;`);
  as(reviewer, `update public.room_members set role = 'owner' where room_id = '${capRoom}'::uuid and user_id = '${reviewer}'::uuid;`);
  ok("reviewer cannot self-promote to editor or owner", as(owner, `select role from public.room_members where room_id = '${capRoom}'::uuid and user_id = '${reviewer}'::uuid;`).out === "reviewer");
  const roomGuard = (uid, column, value) => as(uid, `update public.rooms set ${column} = ${value} where id = '${capRoom}'::uuid;`).failed;
  ok("reviewer cannot change title/media/owner/invite/archive fields", [roomGuard(reviewer, "title", "'blocked'"), roomGuard(reviewer, "media_type", "'video'"), roomGuard(reviewer, "owner_user_id", `'${reviewer}'::uuid`), roomGuard(reviewer, "invite_hash", "'blocked'"), roomGuard(reviewer, "archived_at", "now()")].every(Boolean));
  ok("editor can change title/media but not owner/invite", !roomGuard(editor, "title", "'editor title'") && !roomGuard(editor, "media_type", "'video'") && roomGuard(editor, "owner_user_id", `'${editor}'::uuid`) && roomGuard(editor, "invite_hash", "'blocked-again'"));
  psql(`update public.rooms set title = 'Capability room', media_type = 'image' where id = '${capRoom}'::uuid;`);

  ok("owner can promote reviewer to editor and demote back", !as(owner, `select set_member_role('${capRoom}'::uuid, '${reviewer}'::uuid, 'editor');`).failed && !as(owner, `select set_member_role('${capRoom}'::uuid, '${reviewer}'::uuid, 'reviewer');`).failed);
  ok("non-owner cannot set a member role", as(editor, `select set_member_role('${capRoom}'::uuid, '${reviewer}'::uuid, 'editor');`).failed);
  ok("owner cannot demote themself or pass owner", as(owner, `select set_member_role('${capRoom}'::uuid, '${owner}'::uuid, 'reviewer');`).failed && as(owner, `select set_member_role('${capRoom}'::uuid, '${reviewer}'::uuid, 'owner');`).failed);
  // A room that predates 0007 keeps its behaviour: the column was backfilled to
  // 'editor', so its link still hands out editors. Simulated the way a real one
  // exists — inserted directly, without create_room_with_invite's 'reviewer'.
  const legacyRoom = psql("select gen_random_uuid();").out;
  const legacyToken = "legacy-room-invite-token-0001";
  psql(`insert into public.rooms (id, owner_user_id, title, invite_hash)
        values ('${legacyRoom}'::uuid, '${owner}'::uuid, 'Legacy room', encode(digest('${legacyToken}', 'sha256'), 'hex'));
        insert into public.room_members (room_id, user_id, display_name, color, role)
        values ('${legacyRoom}'::uuid, '${owner}'::uuid, 'Owner', '#c45c4a', 'owner');`);
  ok(
    "既有房間（欄位回填 editor）join 仍發 editor",
    as(owner, `select default_member_role from public.rooms where id = '${legacyRoom}'::uuid;`).out === "editor"
      && !as(joiner, `select join_room_by_invite('${legacyRoom}'::uuid, '${legacyToken}', 'Joiner', '#444444');`).failed
      && as(owner, `select role from public.room_members where room_id = '${legacyRoom}'::uuid and user_id = '${joiner}'::uuid;`).out === "editor",
  );
  // Model a pre-capability room whose compatibility default was backfilled to
  // editor; freshly created rooms below keep the new reviewer default.
  as(owner, `select set_room_default_role('${capRoom}'::uuid, 'editor');`);
  const freshRoom = psql("select gen_random_uuid();").out;
  const freshToken = "fresh-reviewer-room-invite-token";
  psql(`set request.jwt.claim.sub = '${owner}'; select create_room_with_invite('${freshRoom}'::uuid, 'Fresh room', '${freshToken}', 'Owner', '#111111');`);
  ok("新房間 join 發 reviewer", !as(freshJoiner, `select join_room_by_invite('${freshRoom}'::uuid, '${freshToken}', 'Fresh joiner', '#555555');`).failed && as(owner, `select role from public.room_members where room_id = '${freshRoom}'::uuid and user_id = '${freshJoiner}'::uuid;`).out === "reviewer");
  const p0 = as(stranger, `select create_room_with_invite('${capRoom}'::uuid, 'takeover', 'third-party-create-token', 'Stranger', '#999999');`);
  ok("第三人不能用 create_room_with_invite 接管既有房間", p0.failed && as(owner, `select count(*) from public.room_members where room_id = '${capRoom}'::uuid and user_id = '${stranger}'::uuid;`).out === "0");

  section("Version archive：discussion history is preserved");
  const cleanVersion = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}'; insert into public.versions (id, room_id, label, sort_order, image_path) values ('${cleanVersion}'::uuid, '${capRoom}'::uuid, 'clean', 10, 'clean.png');`);
  ok("沒有討論的版本仍可硬刪除", !as(owner, `delete from public.versions where id = '${cleanVersion}'::uuid;`).failed);
  const discussionVersion = psql("select gen_random_uuid();").out;
  const discussionComment = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}'; insert into public.versions (id, room_id, label, sort_order, image_path) values ('${discussionVersion}'::uuid, '${capRoom}'::uuid, 'discussion', 11, 'discussion.png'); insert into public.comments (id, room_id, version_id, author_name, body) values ('${discussionComment}'::uuid, '${capRoom}'::uuid, '${discussionVersion}'::uuid, 'Owner', 'keep this');`);
  const discussionDelete = as(owner, `delete from public.versions where id = '${discussionVersion}'::uuid;`);
  ok("有 comment 的版本硬刪除會被擋下", discussionDelete.failed && discussionDelete.err.includes("version-has-discussion"));
  const strokeVersion = psql("select gen_random_uuid();").out;
  const proposalVersion = psql("select gen_random_uuid();").out;
  const preferenceVersion = psql("select gen_random_uuid();").out;
  const previewVersion = psql("select gen_random_uuid();").out;
  const archivePreview = psql("select gen_random_uuid();").out;
  // Only one enabled preview per room (idx_share_previews_room_enabled), and
  // the capability section left one behind. Retire it before filing the one
  // this section needs.
  psql(`update public.share_previews set enabled = false where id = '${capPreview}'::uuid;`);
  psql(`set request.jwt.claim.sub = '${owner}'; insert into public.versions (id, room_id, label, sort_order, image_path) values ('${strokeVersion}'::uuid, '${capRoom}'::uuid, 'stroke', 12, 'stroke.png'), ('${proposalVersion}'::uuid, '${capRoom}'::uuid, 'proposal', 13, 'proposal.png'), ('${preferenceVersion}'::uuid, '${capRoom}'::uuid, 'preference', 14, 'preference.png'), ('${previewVersion}'::uuid, '${capRoom}'::uuid, 'preview', 15, 'preview.png'); insert into public.strokes (room_id, version_id, color, width, points) values ('${capRoom}'::uuid, '${strokeVersion}'::uuid, '#000', 2, '[]'::jsonb); insert into public.visual_proposals (room_id, version_id, author_name, name, payload) values ('${capRoom}'::uuid, '${proposalVersion}'::uuid, 'Owner', 'Proposal', '{}'::jsonb); insert into public.proposal_preferences (room_id, version_id, user_id, choice) values ('${capRoom}'::uuid, '${preferenceVersion}'::uuid, '${owner}'::uuid, 'yes'); insert into public.share_previews (id, room_id, version_id, title, description) values ('${archivePreview}'::uuid, '${capRoom}'::uuid, '${previewVersion}'::uuid, 'archive preview', 'preview');`);
  for (const [label, version] of [["stroke", strokeVersion], ["visual_proposal", proposalVersion], ["proposal_preference", preferenceVersion], ["share_preview", previewVersion]]) {
    const blocked = as(owner, `delete from public.versions where id = '${version}'::uuid;`);
    ok(`有 ${label} 的版本硬刪除會被擋下`, blocked.failed && blocked.err.includes("version-has-discussion"));
  }
  ok("reviewer cannot archive/restore", as(reviewer, `select archive_version('${discussionVersion}'::uuid);`).failed && as(reviewer, `select restore_version('${discussionVersion}'::uuid);`).failed);
  ok("archive_version keeps version and comments readable", !as(owner, `select archive_version('${discussionVersion}'::uuid);`).failed && as(reviewer, `select archived_at from public.versions where id = '${discussionVersion}'::uuid;`).out !== "" && as(reviewer, `select count(*) from public.comments where id = '${discussionComment}'::uuid;`).out === "1");
  ok("restore_version clears archived_at", !as(owner, `select restore_version('${discussionVersion}'::uuid);`).failed && as(owner, `select archived_at is null from public.versions where id = '${discussionVersion}'::uuid;`).out === "t");
  ok("get_share_preview_v2 reports archived without room/version ids", !as(owner, `select archive_version('${previewVersion}'::uuid);`).failed && asAnon(`select version_archived from public.get_share_preview_v2('${archivePreview}'::uuid);`).out === "t" && psql(`select array_to_string(p.proargnames, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_share_preview_v2';`).out === "p_preview_id,title,description,image_path,updated_at,version_archived");
  ok("get_share_preview_v2 reports false after restore", !as(owner, `select restore_version('${previewVersion}'::uuid);`).failed && asAnon(`select version_archived from public.get_share_preview_v2('${archivePreview}'::uuid);`).out === "f");

  // ------------------------------------------------------- replay safety --
  //
  // Policies are name→definition, and the OLD definitions still live in the old
  // migration files. 0005 is deliberately idempotent (it drops and recreates
  // its policies), so re-running it — rebuilding an environment, restoring a
  // backup, or just checking it is still re-runnable, which this file does at
  // line 163 — quietly reinstates the permissive `share_previews_all` with no
  // error anywhere. 0001 is NOT re-runnable (its CREATE POLICY has no drop, so
  // it fails loudly instead), which is why only 0005 is replayed here.
  //
  // The defence is that the real rules are triggers, whose names appear in no
  // earlier file and which therefore survive any replay.
  section("重放舊 migration 不得讓權限倒退");
  psqlFile(join(MIGRATIONS, "0005_share_previews.sql"));
  const replayVersion = psql("select gen_random_uuid();").out;
  ok(
    "檢視者仍然不能新增版本",
    as(reviewer, `insert into public.versions (id, room_id, label, sort_order, image_path) values ('${replayVersion}'::uuid, '${capRoom}'::uuid, 'replay', 20, 'replay.png');`).failed,
  );
  // A DELETE filtered out by RLS affects zero rows and does NOT error, so the
  // assertion has to be "the comment is still there", not "the call failed".
  as(reviewer, `delete from public.comments where id = '${discussionComment}'::uuid;`);
  ok(
    "檢視者仍然刪不掉別人的留言",
    as(owner, `select count(*) from public.comments where id = '${discussionComment}'::uuid;`).out === "1",
  );
  const replayPreview = psql("select gen_random_uuid();").out;
  ok(
    "重放 0005 之後，檢視者仍然不能建立分享卡片",
    as(reviewer, `insert into public.share_previews (id, room_id, version_id, title, description) values ('${replayPreview}'::uuid, '${capRoom}'::uuid, '${capVersion}'::uuid, 'replayed', 'preview');`).failed,
  );
  ok(
    "重放之後，房主仍然可以正常管理版本",
    !as(owner, `insert into public.versions (id, room_id, label, sort_order, image_path) values ('${replayVersion}'::uuid, '${capRoom}'::uuid, 'replay', 20, 'replay.png');`).failed,
  );

  console.log(`\n${checks - failures}/${checks} 通過`);
} finally {
  if (started) {
    try {
      execFileSync(bin("pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore", env, ...spawnOpts });
    } catch {
      /* already gone */
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sock, { recursive: true, force: true });
}

if (failures) process.exit(1);
