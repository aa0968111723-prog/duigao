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
// port 可覆寫：同一台機器上有多個代理在跑時，寫死的 port 會互相踩到
// （實際發生過：另一個工作線的 migration 測試佔著 55432，這邊起不來，
// 而那個進程不能殺）。`DUIGAO_PG_PORT=55433 npm run test:migrations`。
const PORT = Number(process.env.DUIGAO_PG_PORT ?? 55432);

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

  section("get_share_preview_v3：多回 media_type，其他一樣不外洩 (PR #30)");
  {
    const cols = psql(
      `select string_agg(p.proargnames[i], ',' order by i)
       from pg_proc p, generate_series(1, array_length(p.proargnames, 1)) i
       where p.proname = 'get_share_preview_v3' and p.proargmodes[i] = 't';`,
    ).out;
    ok(
      "回傳欄位是 title/description/image_path/media_type/updated_at/version_archived/revoked",
      cols === "title,description,image_path,media_type,updated_at,version_archived,revoked",
      cols,
    );
    for (const forbidden of ["room_id", "version_id", "created_by"]) {
      ok(`v3 一樣不回傳 ${forbidden}`, !cols.split(",").includes(forbidden));
    }

    ok(
      "圖片房的卡片預設 media_type = image",
      asAnon(`select media_type from public.get_share_preview_v3('${previewId}'::uuid);`).out === "image",
    );

    // A video room's card must be able to say so even with nothing else left.
    const videoRoom = psql("select gen_random_uuid();").out;
    const videoVersion = psql("select gen_random_uuid();").out;
    const videoPreview = psql("select gen_random_uuid();").out;
    psql(
      `set request.jwt.claim.sub = '${owner}';
       select create_room_with_invite('${videoRoom}'::uuid, '未命名影片', 'a-very-long-invite-token-for-video', '主辦方', '#c45c4a');
       update public.rooms set media_type = 'video' where id = '${videoRoom}'::uuid;
       insert into public.versions (id, room_id, label, sort_order, image_path, video_path, mime_type, media_kind, duration_seconds)
         values ('${videoVersion}'::uuid, '${videoRoom}'::uuid, '初剪', 0, 'poster.png', 'cut.webm', 'video/webm', 'video', 83);
       insert into public.share_previews (id, room_id, version_id, title, description, media_type, thumbnail_path)
         values ('${videoPreview}'::uuid, '${videoRoom}'::uuid, '${videoVersion}'::uuid, '淡江招生短片｜第一剪', '幫我看一下這支影片', 'video', '${videoPreview}/cover.webp');`,
    );
    ok(
      "影片房的卡片 media_type = video",
      asAnon(`select media_type from public.get_share_preview_v3('${videoPreview}'::uuid);`).out === "video",
    );
    ok(
      "撤銷後仍回得出 media_type（才知道要用「影片對稿」當招牌）",
      !as(owner, `update public.share_previews set enabled = false where id = '${videoPreview}'::uuid;`).failed &&
        asAnon(`select media_type from public.get_share_preview_v3('${videoPreview}'::uuid);`).out === "video",
    );
    ok(
      "撤銷後標題與縮圖都是 null（看不到原本寫了什麼）",
      asAnon(
        `select coalesce(title, 'NULL') || '/' || coalesce(image_path, 'NULL')
           from public.get_share_preview_v3('${videoPreview}'::uuid);`,
      ).out === "NULL/NULL",
    );
    ok(
      "撤銷後 revoked = true",
      asAnon(`select revoked from public.get_share_preview_v3('${videoPreview}'::uuid);`).out === "t",
    );
    ok(
      "舊的 get_share_preview 對撤銷的卡片仍然完全查不到（行為沒變）",
      asAnon(`select count(*) from public.get_share_preview('${videoPreview}'::uuid);`).out === "0",
    );
    ok(
      "猜 room id 一樣拿不到 v3",
      asAnon(`select count(*) from public.get_share_preview_v3('${videoRoom}'::uuid);`).out === "0",
    );

    // The new columns are constrained, not free text: a typo'd cover_source
    // would silently mean "no cover" everywhere downstream.
    ok(
      "media_type 只收 image/video",
      as(owner, `update public.share_previews set media_type = 'gif' where id = '${videoPreview}'::uuid;`).failed,
    );
    ok(
      "cover_source 只收 auto/custom/none",
      as(owner, `update public.share_previews set cover_source = 'whatever' where id = '${videoPreview}'::uuid;`).failed,
    );
    ok(
      "cover_source 預設是 auto，自訂旗標預設是 false",
      psql(
        `select cover_source || '/' || title_customized || '/' || description_customized
           from public.share_previews where id = '${previewId}'::uuid;`,
      ).out === "auto/false/false",
    );
    ok(
      "0011 之前的 row 也補到 auto（show_thumbnail 就是它當年的意思）",
      psql("select count(*) from public.share_previews where cover_source is null;").out === "0",
    );
    ok(
      "分享自訂不會、也不能寫回 rooms.title",
      psql(`select title from public.rooms where id = '${videoRoom}'::uuid;`).out === "未命名影片",
    );
    ok(
      "share_previews 沒有任何欄位叫 invite",
      psql(
        `select count(*) from information_schema.columns
          where table_name = 'share_previews' and column_name ilike '%invite%';`,
      ).out === "0",
    );
  }

  section("0011 可以重複套用（idempotent）");
  {
    const shape = () =>
      psql(
        `select
           (select count(*) from information_schema.columns where table_name = 'share_previews') || '/' ||
           (select count(*) from pg_constraint where conname like 'share_previews_%_check');`,
      ).out;
    const before = shape();
    psqlFile(join(MIGRATIONS, "0011_share_preview_customization.sql"));
    ok("重跑 0011 之後欄位與 constraint 數量完全一樣", before === shape(), `${before} → ${shape()}`);
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

  section("Storage 孤兒資產：只盤點與清除沒有版本參照的舊物件");
  {
    const linkedVersion = psql("select gen_random_uuid();").out;
    const orphanAsset = `rooms/${roomId}/videos/orphan-test/orphan.webm`;
    const linkedAsset = `rooms/${roomId}/videos/linked-test/linked.webm`;
    psql(`insert into storage.objects (bucket_id, name, created_at)
            values ('room-assets', '${orphanAsset}', now() - interval '8 days'),
                   ('room-assets', '${linkedAsset}', now() - interval '8 days');
          insert into public.versions
            (id, room_id, label, sort_order, image_path, media_kind, video_path, created_by)
          values ('${linkedVersion}'::uuid, '${roomId}'::uuid, '孤兒測試參照', 98, null, 'video', '${linkedAsset}', '${owner}'::uuid);`);
    ok(
      "orphaned_room_assets 只盤點沒有版本參照的舊物件",
      psql(`select name from public.orphaned_room_assets(interval '0 seconds') where name = '${orphanAsset}';`).out === orphanAsset
        && psql(`select name from public.orphaned_room_assets(interval '0 seconds') where name = '${linkedAsset}';`).out === "",
    );
    ok(
      "purge_orphaned_room_assets 受單次上限保護且不刪有參照物件",
      psql("select name from public.purge_orphaned_room_assets(interval '0 seconds', 1);").out === orphanAsset
        && psql(`select count(*) from storage.objects where bucket_id = 'room-assets' and name = '${linkedAsset}';`).out === "1",
    );
    psql(`delete from storage.objects where bucket_id = 'room-assets' and name = '${linkedAsset}';
          delete from public.versions where id = '${linkedVersion}'::uuid;`);
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
    const insertVideoResult = as(owner, insertVideo);
    ok("成員可以新增影片版本", !insertVideoResult.failed, insertVideoResult.err);

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
    const nullDurationResult = as(
      owner,
      `insert into public.versions (id, room_id, label, sort_order, media_kind, video_path)
       values ('${nullDuration}'::uuid, '${roomId}'::uuid, '長度未知', 8, 'video', 'rooms/x/v2.mp4');`,
    );
    ok("duration 讀不到時寫 NULL 是允許的", !nullDurationResult.failed, nullDurationResult.err);
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
    const pointResult = as(
      owner,
      `insert into public.comments (id, room_id, version_id, author_name, anchor_type, time_seconds, body)
       values ('${pointId}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '夥伴', 'video-point', 13.42, '字幕出現太慢');`,
    );
    ok("影片時間點留言", !pointResult.failed, pointResult.err);

    const rangeId = psql("select gen_random_uuid();").out;
    const rangeResult = as(
      owner,
      `insert into public.comments (id, room_id, version_id, author_name, anchor_type, time_seconds, end_time_seconds, body)
       values ('${rangeId}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '夥伴', 'video-range', 22, 27.5, '這段轉場太突然');`,
    );
    ok("影片片段留言", !rangeResult.failed, rangeResult.err);

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
    const videoPreviewResult = as(
      owner,
      `insert into public.share_previews (id, room_id, version_id, title, description)
       values ('${videoPreviewId}'::uuid, '${roomId}'::uuid, '${videoVersionId}'::uuid, '影片對稿', '幫我看一下這支影片');`,
    );
    ok("share_previews 可以指向一支影片版本", !videoPreviewResult.failed, videoPreviewResult.err);
    psql(`delete from public.share_previews where id = '${videoPreviewId}'::uuid;`);

    // 0011 adds media_type on a NEW function (v3). This assertion is what keeps
    // the old one re-runnable: changing v1's return type would make a replay of
    // 0005 fail with "cannot change return type of existing function".
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
      // 0018 新增 room_assets_attachments_insert（成員可寫 attachments 前綴）
      "room-assets 的五條 policy 還在",
      psql("select count(*) from pg_policies where tablename = 'objects' and policyname like 'room_assets_%';").out === "5",
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

  // -------------------------------------------------------- project rooms
  section("同房多分支：branch / plan / relation / poll 的 RLS 與相容層");
  const projectPoster = psql("select gen_random_uuid();").out;
  const projectVideo = psql("select gen_random_uuid();").out;
  const projectPlan = psql("select gen_random_uuid();").out;
  const projectPosterVersion = psql("select gen_random_uuid();").out;
  const projectVideoVersion = psql("select gen_random_uuid();").out;
  const projectPoll = psql("select gen_random_uuid();").out;
  const projectRelation = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}';
    insert into public.room_branches (id, room_id, name, branch_type, sort_order, created_by)
      values ('${projectPoster}'::uuid, '${capRoom}'::uuid, '演講文宣', 'poster', 0, '${owner}'::uuid),
             ('${projectVideo}'::uuid, '${capRoom}'::uuid, '招生影片', 'video', 1, '${owner}'::uuid),
             ('${projectPlan}'::uuid, '${capRoom}'::uuid, '擺攤計畫', 'plan', 2, '${owner}'::uuid);
    update public.rooms set room_mode = 'project' where id = '${capRoom}'::uuid;
    insert into public.versions (id, room_id, label, sort_order, image_path, media_kind, video_path, branch_id)
      values ('${projectPosterVersion}'::uuid, '${capRoom}'::uuid, '文宣初稿', 50, 'project-poster.png', 'image', null, '${projectPoster}'::uuid),
             ('${projectVideoVersion}'::uuid, '${capRoom}'::uuid, '影片第一剪', 51, 'project-video.png', 'video', 'project-video.webm', '${projectVideo}'::uuid);
    insert into public.plan_documents (branch_id, room_id, title, description, blocks)
      values ('${projectPlan}'::uuid, '${capRoom}'::uuid, '擺攤計畫', '招募新生', '[{"id":"b1","kind":"checklist","text":"QR code","checked":false}]'::jsonb);
    insert into public.content_relations (id, room_id, from_branch_id, to_branch_id)
      values ('${projectRelation}'::uuid, '${capRoom}'::uuid, '${projectPlan}'::uuid, '${projectPoster}'::uuid);
    insert into public.room_polls (id, room_id, question, options)
      values ('${projectPoll}'::uuid, '${capRoom}'::uuid, '這週先主推哪一份？', '["茶會","演講"]'::jsonb);`);
  ok(
    "owner/editor 可以建立同房多分支與關聯內容",
    !as(editor, `insert into public.room_branches (room_id, name, branch_type) values ('${capRoom}'::uuid, 'Editor 文案', 'copy');`).failed
      && as(owner, `select count(*) from public.room_branches where room_id = '${capRoom}'::uuid and id in ('${projectPoster}'::uuid, '${projectVideo}'::uuid, '${projectPlan}'::uuid);`).out === "3"
      && as(owner, `select count(*) from public.content_relations where id = '${projectRelation}'::uuid;`).out === "1",
  );
  ok(
    "版本各自屬於正確 branch",
    as(reviewer, `select count(*) from public.versions where id = '${projectPosterVersion}'::uuid and branch_id = '${projectPoster}'::uuid;`).out === "1"
      && as(reviewer, `select count(*) from public.versions where id = '${projectVideoVersion}'::uuid and branch_id = '${projectVideo}'::uuid;`).out === "1",
  );
  const reviewerSummary = as(reviewer, `select count(*) from public.get_room_branch_summaries('${capRoom}'::uuid);`);
  ok("reviewer 可以讀 branch summary / plan / relation / poll", !as(reviewer, `select count(*) from public.room_branches where room_id = '${capRoom}'::uuid;`).failed && reviewerSummary.out === "5" && as(reviewer, `select count(*) from public.plan_documents where branch_id = '${projectPlan}'::uuid;`).out === "1" && as(reviewer, `select count(*) from public.content_relations where id = '${projectRelation}'::uuid;`).out === "1" && as(reviewer, `select count(*) from public.room_polls where id = '${projectPoll}'::uuid;`).out === "1");
  ok("reviewer 不能建立 branch / plan / relation / poll", [
    as(reviewer, `insert into public.room_branches (room_id, name, branch_type) values ('${capRoom}'::uuid, 'blocked', 'copy');`),
    as(reviewer, `insert into public.plan_documents (branch_id, room_id, title, blocks) values ('${projectPlan}'::uuid, '${capRoom}'::uuid, 'blocked', '[]'::jsonb);`),
    as(reviewer, `insert into public.content_relations (room_id, from_branch_id, to_branch_id) values ('${capRoom}'::uuid, '${projectPlan}'::uuid, '${projectVideo}'::uuid);`),
    as(reviewer, `insert into public.room_polls (room_id, question, options) values ('${capRoom}'::uuid, 'blocked', '["A","B"]'::jsonb);`),
  ].every((result) => result.failed));
  ok(
    "reviewer 可以投票，且只能寫自己的 user_id",
    !as(reviewer, `insert into public.room_poll_votes (poll_id, room_id, option) values ('${projectPoll}'::uuid, '${capRoom}'::uuid, '茶會');`).failed
      && as(reviewer, `select count(*) from public.room_poll_votes where poll_id = '${projectPoll}'::uuid and user_id = '${reviewer}'::uuid;`).out === "1"
      && as(reviewer, `insert into public.room_poll_votes (poll_id, room_id, user_id, option) values ('${projectPoll}'::uuid, '${capRoom}'::uuid, '${owner}'::uuid, '演講');`).failed,
  );
  const archivedBranch = as(owner, `update public.room_branches set status = 'archived' where id = '${projectPlan}'::uuid;`);
  const archivedBranchRead = as(owner, `select archived_at is not null from public.room_branches where id = '${projectPlan}'::uuid;`);
  const archivedBranchDelete = as(owner, `delete from public.room_branches where id = '${projectPlan}'::uuid;`);
  ok("有歷史內容的 branch 只能封存，不能 hard delete", !archivedBranch.failed && archivedBranchRead.out === "t" && archivedBranchDelete.failed, [archivedBranch.err, archivedBranchRead.err, archivedBranchDelete.err].filter(Boolean).join(" | "));
  ok("匿名讀不到 project tables / summary RPC", asAnon(`select count(*) from public.room_branches;`).out !== "1" && asAnon(`select count(*) from public.room_polls;`).out !== "1" && asAnon(`select count(*) from public.get_room_branch_summaries('${capRoom}'::uuid);`).failed);

  const compatImageRoom = psql("select gen_random_uuid();").out;
  const compatVideoRoom = psql("select gen_random_uuid();").out;
  const compatImageVersion = psql("select gen_random_uuid();").out;
  const compatVideoVersion = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}';
    select create_room_with_invite('${compatImageRoom}'::uuid, '舊文宣房', 'compat-image-token', 'Owner', '#111111');
    insert into public.versions (id, room_id, label, sort_order, image_path) values ('${compatImageVersion}'::uuid, '${compatImageRoom}'::uuid, '舊圖初稿', 0, 'old.png');
    select create_room_with_invite('${compatVideoRoom}'::uuid, '舊影片房', 'compat-video-token', 'Owner', '#111111');
    update public.rooms set media_type = 'video' where id = '${compatVideoRoom}'::uuid;
    insert into public.versions (id, room_id, label, sort_order, image_path, media_kind, video_path) values ('${compatVideoVersion}'::uuid, '${compatVideoRoom}'::uuid, '舊片初剪', 0, 'old.png', 'video', 'old.webm');`);
  ok("舊 image / video room 自動建立相容 branch", as(owner, `select count(*) from public.room_branches where room_id = '${compatImageRoom}'::uuid and branch_type = 'poster';`).out === "1" && as(owner, `select count(*) from public.room_branches where room_id = '${compatVideoRoom}'::uuid and branch_type = 'video';`).out === "1" && as(owner, `select count(*) from public.versions where id = '${compatImageVersion}'::uuid and branch_id is not null;`).out === "1" && as(owner, `select count(*) from public.versions where id = '${compatVideoVersion}'::uuid and branch_id is not null;`).out === "1");

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

  // ======================= PR #32: 影片審片 =======================
  section("影片審片：作者說明只有 owner/editor 能寫，reviewer 只能讀");
  {
    const vRoom = psql("select gen_random_uuid();").out;
    const vVersion = psql("select gen_random_uuid();").out;
    const vToken = "a-very-long-invite-token-for-review-2";
    psql(
      `set request.jwt.claim.sub = '${owner}';
       select create_room_with_invite('${vRoom}'::uuid, '招生短片', '${vToken}', '主辦方', '#c45c4a');
       update public.rooms set media_type = 'video' where id = '${vRoom}'::uuid;
       insert into public.versions (id, room_id, label, sort_order, image_path, video_path, mime_type, media_kind, duration_seconds)
         values ('${vVersion}'::uuid, '${vRoom}'::uuid, '初剪', 0, 'poster.png', 'cut.webm', 'video/webm', 'video', 83);`,
    );
    // A reviewer joins through the link, exactly like a partner from LINE.
    const vReviewer = psql("insert into auth.users default values returning id;").out;
    psql(`set request.jwt.claim.sub = '${vReviewer}'; select join_room_by_invite('${vRoom}'::uuid, '${vToken}', '夥伴', '#3d6b8c');`);
    psql(`update public.room_members set role = 'reviewer' where room_id = '${vRoom}'::uuid and user_id = '${vReviewer}'::uuid;`);

    const briefInsert = `insert into public.version_review_briefs (version_id, room_id, body, focus_tags, questions)
       values ('${vVersion}'::uuid, '${vRoom}'::uuid, '這次想確認節奏', '["節奏","字幕"]'::jsonb, '["前 10 秒有吸引你嗎？"]'::jsonb);`;
    ok("reviewer 不能寫作者說明", as(vReviewer, briefInsert).failed);
    ok("owner 可以寫作者說明", !as(owner, briefInsert).failed);
    ok(
      "reviewer 讀得到作者說明",
      as(vReviewer, `select body from public.version_review_briefs where version_id = '${vVersion}'::uuid;`).out === "這次想確認節奏",
    );
    ok(
      "reviewer 不能改作者說明",
      as(vReviewer, `update public.version_review_briefs set body = 'hacked' where version_id = '${vVersion}'::uuid;`).failed ||
        as(owner, `select body from public.version_review_briefs where version_id = '${vVersion}'::uuid;`).out === "這次想確認節奏",
    );
    ok("最多三個問題", as(owner, `update public.version_review_briefs set questions = '["a","b","c","d"]'::jsonb where version_id = '${vVersion}'::uuid;`).failed);
    ok("匿名讀不到作者說明", asAnon("select count(*) from public.version_review_briefs;").out !== "1");

    section("影片審片：快速反應只能寫自己的，連點會被資料庫擋掉");
    const react = (uid, t, type) =>
      as(uid, `insert into public.video_reactions (room_id, version_id, user_id, time_seconds, reaction_type)
                 values ('${vRoom}'::uuid, '${vVersion}'::uuid, '${uid}'::uuid, ${t}, '${type}');`);
    ok("reviewer 可以按反應", !react(vReviewer, 21.2, "fast").failed);
    ok("同一秒附近重複按同一個反應會被擋", react(vReviewer, 21.9, "fast").failed);
    ok("同一時間不同反應可以並存", !react(vReviewer, 21.4, "love").failed);
    ok("離得夠遠的同一反應可以再按", !react(vReviewer, 40.0, "fast").failed);
    ok(
      "不能用別人的身分按反應",
      as(vReviewer, `insert into public.video_reactions (room_id, version_id, user_id, time_seconds, reaction_type)
                       values ('${vRoom}'::uuid, '${vVersion}'::uuid, '${owner}'::uuid, 5, 'ok');`).failed,
    );
    ok("非成員按不了反應", react(stranger, 3, "ok").failed);
    ok("不合法的反應種類被擋下", react(owner, 9, "angry").failed);
    ok("匿名讀不到反應", asAnon("select count(*) from public.video_reactions;").out !== "1");

    section("影片審片：verdict 一人一版一列，可改，不能改別人的");
    const verdict = (uid, v) =>
      as(uid, `insert into public.version_verdicts (version_id, user_id, room_id, verdict)
                 values ('${vVersion}'::uuid, '${uid}'::uuid, '${vRoom}'::uuid, '${v}')
               on conflict (version_id, user_id) do update set verdict = excluded.verdict;`);
    ok("reviewer 可以表態", !verdict(vReviewer, "minor").failed);
    ok("同一人再表態是更新，不是第二列", !verdict(vReviewer, "pass").failed &&
      psql(`select count(*) from public.version_verdicts where version_id = '${vVersion}'::uuid and user_id = '${vReviewer}'::uuid;`).out === "1");
    ok("verdict 只收三種語義", verdict(vReviewer, "五顆星").failed);
    ok(
      "不能改別人的 verdict",
      as(owner, `update public.version_verdicts set verdict = 'revise' where user_id = '${vReviewer}'::uuid and version_id = '${vVersion}'::uuid;`).failed ||
        psql(`select verdict from public.version_verdicts where user_id = '${vReviewer}'::uuid and version_id = '${vVersion}'::uuid;`).out === "pass",
    );
    ok("作者讀得到聚合", !as(owner, `select count(*) from public.version_verdicts where version_id = '${vVersion}'::uuid;`).failed);

    section("影片審片：觀看進度只准前進，而且只有兩個事實");
    as(vReviewer, `insert into public.version_review_progress (version_id, user_id, room_id, max_watched_seconds)
                     values ('${vVersion}'::uuid, '${vReviewer}'::uuid, '${vRoom}'::uuid, 60);`);
    as(vReviewer, `update public.version_review_progress set max_watched_seconds = 10
                    where version_id = '${vVersion}'::uuid and user_id = '${vReviewer}'::uuid;`);
    ok(
      "倒帶重看不會把進度改小",
      psql(`select max_watched_seconds from public.version_review_progress where user_id = '${vReviewer}'::uuid;`).out === "60",
    );
    ok(
      "看完之後不會被清掉",
      !as(vReviewer, `update public.version_review_progress set completed_at = now() where user_id = '${vReviewer}'::uuid and version_id = '${vVersion}'::uuid;`).failed &&
        !as(vReviewer, `update public.version_review_progress set completed_at = null where user_id = '${vReviewer}'::uuid and version_id = '${vVersion}'::uuid;`).failed &&
        psql(`select completed_at is not null from public.version_review_progress where user_id = '${vReviewer}'::uuid;`).out === "t",
    );
    ok(
      "進度表只有 max_watched / completed 兩個事實，沒有行為欄位",
      psql(
        `select count(*) from information_schema.columns
          where table_name = 'version_review_progress'
            and column_name in ('play_count','pause_count','user_agent','device','ip','events','heatmap','session_id');`,
      ).out === "0",
    );

    section("影片審片：回饋狀態——reviewer 保留 resolve，但不能標「處理中／不採用」");
    const revComment = psql("select gen_random_uuid();").out;
    as(vReviewer, `insert into public.comments (id, room_id, version_id, author_name, body, anchor_type, time_seconds)
                     values ('${revComment}'::uuid, '${vRoom}'::uuid, '${vVersion}'::uuid, '夥伴', '這段太快', 'video-point', 21);`);
    ok(
      "0007 的既有能力保留：reviewer 仍可 resolve 自己的留言",
      !as(vReviewer, `update public.comments set resolved = true where id = '${revComment}'::uuid;`).failed,
    );
    ok(
      "resolved 會同步成 done（舊 client 也看得到正確狀態）",
      psql(`select review_status from public.comments where id = '${revComment}'::uuid;`).out === "done",
    );
    ok(
      "取消 resolved 會回到 open，不會變成 wontfix",
      !as(vReviewer, `update public.comments set resolved = false where id = '${revComment}'::uuid;`).failed &&
        psql(`select review_status from public.comments where id = '${revComment}'::uuid;`).out === "open",
    );
    const ownerComment2 = psql("select gen_random_uuid();").out;
    as(owner, `insert into public.comments (id, room_id, version_id, author_name, body, anchor_type, time_seconds)
                 values ('${ownerComment2}'::uuid, '${vRoom}'::uuid, '${vVersion}'::uuid, '主辦方', '字幕太快', 'video-point', 42);`);
    ok(
      "reviewer 不能把別人的回饋標成「不採用」",
      as(vReviewer, `update public.comments set review_status = 'wontfix' where id = '${ownerComment2}'::uuid;`).failed,
    );
    const doingRes = as(owner, `update public.comments set review_status = 'doing' where id = '${ownerComment2}'::uuid;`);
    ok(
      "owner 可以標「處理中」與「不採用」",
      !doingRes.failed &&
        !as(owner, `update public.comments set review_status = 'wontfix' where id = '${ownerComment2}'::uuid;`).failed,
      doingRes.err ? doingRes.err.split("\n").slice(0,3).join(" | ") : "",
    );
    ok(
      "「不採用」也會讓舊 client 的 resolved 變 true",
      psql(`select resolved from public.comments where id = '${ownerComment2}'::uuid;`).out === "t",
    );
    ok("review_status 只收四種", as(owner, `update public.comments set review_status = 'maybe' where id = '${ownerComment2}'::uuid;`).failed);

    section("影片審片：0012 可以重複套用");
    const shape = () =>
      psql(
        `select
           (select count(*) from information_schema.columns where table_name in
             ('version_review_briefs','video_reactions','version_verdicts','version_review_progress')) || '/' ||
           (select count(*) from pg_policies where tablename in
             ('version_review_briefs','video_reactions','version_verdicts','version_review_progress'));`,
      ).out;
    const before12 = shape();
    psqlFile(join(MIGRATIONS, "0012_video_review_feedback.sql"));
    ok("重跑 0012 之後欄位與 policy 數量完全一樣", before12 === shape(), `${before12} → ${shape()}`);
    ok(
      "重跑之後 reviewer 仍然不能寫作者說明",
      as(vReviewer, `update public.version_review_briefs set body = 'hacked again' where version_id = '${vVersion}'::uuid;`).failed ||
        psql(`select body from public.version_review_briefs where version_id = '${vVersion}'::uuid;`).out === "這次想確認節奏",
    );
  }

  section("同房多分支：0013 migration 可以重跑");
  const projectShape = () => psql(`select
    (select count(*) from information_schema.tables where table_name in ('room_branches', 'plan_documents', 'content_relations', 'room_polls', 'room_poll_votes')) || '/' ||
    (select count(*) from pg_policies where tablename in ('room_branches', 'plan_documents', 'content_relations', 'room_polls', 'room_poll_votes')) || '/' ||
    (select count(*) from pg_indexes where indexname in ('idx_room_branches_room_sort', 'idx_plan_documents_room', 'idx_content_relations_from', 'idx_room_polls_room')) || '/' ||
    (select count(*) from pg_trigger where tgname in ('room_branches_no_delete', 'versions_assign_branch'));`).out;
  const projectShapeBefore = projectShape();
  psqlFile(join(MIGRATIONS, "0013_project_room_branches.sql"));
  ok("重跑 0013 之後 tables / policies / indexes / triggers 數量不變", projectShapeBefore === projectShape(), `${projectShapeBefore} → ${projectShape()}`);
  const replayArchive = as(owner, `update public.room_branches set status = 'completed' where id = '${projectPoster}'::uuid;`);
  const replayDelete = as(owner, `delete from public.room_branches where id = '${projectPoster}'::uuid;`);
  ok("重跑 0013 後 branch 封存規則仍在", !replayArchive.failed && replayDelete.failed, [replayArchive.err, replayDelete.err].filter(Boolean).join(" | "));

  section("Asset Intelligence：統一素材、分析佇列、版本優先與 RLS");
  const intelligenceShape = () => psql(`select
    (select count(*) from information_schema.tables where table_name in ('intelligent_assets','asset_analysis','asset_regions','asset_video_segments','asset_document_chunks','asset_relations','asset_embeddings','asset_human_metadata','asset_analysis_jobs')) || '/' ||
    (select count(*) from pg_policies where tablename in ('intelligent_assets','asset_analysis','asset_regions','asset_video_segments','asset_document_chunks','asset_relations','asset_embeddings','asset_human_metadata','asset_analysis_jobs')) || '/' ||
    (select count(*) from pg_indexes where indexname in ('idx_intelligent_assets_room_type_updated','idx_asset_video_segments_asset_time','idx_asset_document_chunks_asset','idx_asset_relations_source','idx_asset_analysis_jobs_asset')) || '/' ||
    (select count(*) from pg_trigger where tgname in ('versions_sync_intelligent_asset','intelligent_assets_enqueue','asset_relations_room_guard'));`).out;
  const intelligenceBefore = intelligenceShape();
  psqlFile(join(MIGRATIONS, "0015_asset_intelligence.sql"));
  ok("0015 可以重複套用，tables / policies / indexes / triggers 數量不變", intelligenceBefore === intelligenceShape(), `${intelligenceBefore} → ${intelligenceShape()}`);
  const posterAsset = as(owner, `select id from public.intelligent_assets where version_id = '${projectPosterVersion}'::uuid;`).out;
  const videoAsset = as(owner, `select id from public.intelligent_assets where version_id = '${projectVideoVersion}'::uuid;`).out;
  const planAsset = as(owner, `select id from public.intelligent_assets where branch_id = '${projectPlan}'::uuid and asset_type = 'plan';`).out;
  ok(
    "既有 image / video / plan 自動建立統一 asset 並保留版本關係",
    Boolean(posterAsset) && Boolean(videoAsset) && Boolean(planAsset)
      && as(owner, `select asset_type from public.intelligent_assets where id = '${posterAsset}'::uuid;`).out === "image"
      && as(owner, `select asset_type from public.intelligent_assets where id = '${videoAsset}'::uuid;`).out === "video"
      && as(owner, `select asset_type from public.intelligent_assets where id = '${planAsset}'::uuid;`).out === "plan",
  );
  ok(
    "新增 asset 會排入 Tier 1 且同一分析版本去重",
    as(owner, `select count(*) from public.asset_analysis_jobs where asset_id in ('${posterAsset}'::uuid, '${videoAsset}'::uuid, '${planAsset}'::uuid) and tier = 1 and status = 'queued';`).out === "3",
  );
  const customAsset = psql("select gen_random_uuid();").out;
  const customKey = `manual:${customAsset}`;
  const customInsert = as(owner, `insert into public.intelligent_assets (id, room_id, branch_id, asset_type, title, source_key, ai_readable, external_ai_allowed, created_by) values ('${customAsset}'::uuid, '${capRoom}'::uuid, '${projectPoster}'::uuid, 'image', '擺攤照片', '${customKey}', true, false, '${owner}'::uuid);`);
  const customSelect = as(reviewer, `select id from public.intelligent_assets where id = '${customAsset}'::uuid;`);
  const customUpdate = as(reviewer, `update public.intelligent_assets set title = '越權' where id = '${customAsset}'::uuid;`);
  const customTitleAfterReviewerUpdate = as(owner, `select title from public.intelligent_assets where id = '${customAsset}'::uuid;`);
  ok(
    "owner 可以建立自訂素材，reviewer 只能讀",
    !customInsert.failed && !customSelect.failed && customTitleAfterReviewerUpdate.out === "擺攤照片",
    JSON.stringify({
      insert: { failed: customInsert.failed, out: customInsert.out, err: customInsert.err },
      select: { failed: customSelect.failed, out: customSelect.out, err: customSelect.err },
      update: { failed: customUpdate.failed, out: customUpdate.out, err: customUpdate.err },
      titleAfterReviewerUpdate: customTitleAfterReviewerUpdate.out,
    }),
  );
  ok(
    "reviewer 不能寫分析、區域、時間片段或關聯",
    [
      as(reviewer, `insert into public.asset_analysis (asset_id, room_id, summary) values ('${customAsset}'::uuid, '${capRoom}'::uuid, 'blocked');`),
      as(reviewer, `insert into public.asset_regions (asset_id, room_id, x, y, width, height) values ('${customAsset}'::uuid, '${capRoom}'::uuid, .1, .1, .2, .2);`),
      as(reviewer, `insert into public.asset_video_segments (asset_id, room_id, start_seconds, end_seconds) values ('${customAsset}'::uuid, '${capRoom}'::uuid, 1, 2);`),
      as(reviewer, `insert into public.asset_relations (room_id, source_asset_id, target_asset_id, relation_type) values ('${capRoom}'::uuid, '${customAsset}'::uuid, '${posterAsset}'::uuid, 'related_to');`),
    ].every((result) => result.failed),
  );
  ok(
    "子表 room_id 與 asset 不一致會被 guard 擋下",
    as(owner, `insert into public.asset_analysis (asset_id, room_id, summary) values ('${customAsset}'::uuid, '${roomId}'::uuid, 'cross-room');`).failed,
  );
  const otherAsset = psql("select gen_random_uuid();").out;
  as(stranger, `insert into public.intelligent_assets (id, room_id, asset_type, title, source_key, created_by) values ('${otherAsset}'::uuid, '${roomId}'::uuid, 'image', 'room asset', 'manual:${otherAsset}', '${stranger}'::uuid);`);
  ok(
    "跨房間 asset relation 會被 guard 擋下，非成員讀不到",
    as(owner, `insert into public.asset_relations (room_id, source_asset_id, target_asset_id, relation_type) values ('${capRoom}'::uuid, '${customAsset}'::uuid, '${otherAsset}'::uuid, 'related_to');`).failed
      && as(stranger, `select count(*) from public.intelligent_assets where id = '${customAsset}'::uuid;`).out === "0",
  );
  const regionId = psql("select gen_random_uuid();").out;
  const segmentId = psql("select gen_random_uuid();").out;
  ok(
    "owner 可保存 normalized region、影片 timestamp segment 與 human override",
    !as(owner, `insert into public.asset_regions (id, asset_id, room_id, region_type, label, x, y, width, height, confidence) values ('${regionId}'::uuid, '${customAsset}'::uuid, '${capRoom}'::uuid, 'headline', '主標題', .12, .08, .76, .13, .94);`).failed
      && !as(owner, `insert into public.asset_video_segments (id, asset_id, room_id, start_seconds, end_seconds, summary) values ('${segmentId}'::uuid, '${videoAsset}'::uuid, '${capRoom}'::uuid, 42, 55, '禪學社介紹');`).failed
      && !as(owner, `insert into public.asset_human_metadata (asset_id, room_id, title, tags) values ('${customAsset}'::uuid, '${capRoom}'::uuid, '茶會照片', '{"茶會","主視覺"}');`).failed,
  );
  ok(
    "不合法 normalized region 會被資料庫擋下",
    as(owner, `insert into public.asset_regions (asset_id, room_id, x, y, width, height) values ('${customAsset}'::uuid, '${capRoom}'::uuid, .9, .1, .2, .2);`).failed,
  );
  ok(
    "anon 讀不到所有 intelligence 表",
    asAnon(`select count(*) from public.intelligent_assets;`).out !== "1"
      && asAnon(`select count(*) from public.asset_analysis_jobs;`).out !== "1"
      && asAnon(`select count(*) from public.asset_relations;`).out !== "1",
  );
  section("協作工作台：0014 whiteboard / discussion / decision RLS");
  const collabBoard = psql("select gen_random_uuid();").out;
  const collabNode = psql("select gen_random_uuid();").out;
  const collabEdge = psql("select gen_random_uuid();").out;
  const collabMsg = psql("select gen_random_uuid();").out;
  const collabDecision = psql("select gen_random_uuid();").out;
  const otherRoom = psql("select gen_random_uuid();").out;
  const otherBoard = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}';
    insert into public.whiteboards (id, room_id, title, description)
      values ('${collabBoard}'::uuid, '${capRoom}'::uuid, '招生規劃', '活動討論');
    insert into public.whiteboard_nodes (id, whiteboard_id, room_id, node_type, x, y, content)
      values ('${collabNode}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, 'text', 20, 20, '{"text":"招生"}'::jsonb);`);
  const selfEdge = as(owner, `insert into public.whiteboard_edges (id, whiteboard_id, room_id, source_node_id, target_node_id, edge_type) values ('${collabEdge}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, '${collabNode}'::uuid, '${collabNode}'::uuid, 'default');`);
  ok("edge 不能連到自己", selfEdge.failed);
  const secondNode = psql("select gen_random_uuid();").out;
  ok(
    "owner 可以建立白板與節點",
    !as(owner, `insert into public.whiteboard_nodes (id, whiteboard_id, room_id, node_type, content) values ('${secondNode}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, 'flow', '{"text":"擺攤"}'::jsonb);`).failed
      && as(owner, `select count(*) from public.whiteboards where id = '${collabBoard}'::uuid;`).out === "1",
  );
  ok(
    "reviewer 可以讀白板與參加討論",
    as(reviewer, `select count(*) from public.whiteboards where id = '${collabBoard}'::uuid;`).out === "1"
      && !as(reviewer, `insert into public.room_discussion_messages (id, room_id, author_name, body) values ('${collabMsg}'::uuid, '${capRoom}'::uuid, 'Reviewer', '先看招生流程');`).failed,
  );
  ok(
    "reviewer 預設不能建整塊白板或刪除白板",
    as(reviewer, `insert into public.whiteboards (room_id, title) values ('${capRoom}'::uuid, 'blocked');`).failed
      && as(reviewer, `delete from public.whiteboards where id = '${collabBoard}'::uuid;`).failed,
  );
  as(reviewer, `update public.whiteboard_nodes set content = '{"text":"hack"}'::jsonb where id = '${collabNode}'::uuid;`);
  ok(
    "reviewer 預設不能改節點，直到房主開放協作",
    as(owner, `select content->>'text' from public.whiteboard_nodes where id = '${collabNode}'::uuid;`).out === "招生",
  );
  const openEdit = as(owner, `update public.rooms set allow_board_edit = true where id = '${capRoom}'::uuid;`);
  as(reviewer, `update public.whiteboard_nodes set content = '{"text":"一起改"}'::jsonb where id = '${collabNode}'::uuid;`);
  ok(
    "開放 allow_board_edit 後 reviewer 可以編節點",
    !openEdit.failed && as(owner, `select content->>'text' from public.whiteboard_nodes where id = '${collabNode}'::uuid;`).out === "一起改",
    openEdit.err,
  );
  as(reviewer, `update public.whiteboards set archived_at = now() where id = '${collabBoard}'::uuid;`);
  ok(
    "reviewer 仍然不能封存整塊白板",
    as(owner, `select archived_at is null from public.whiteboards where id = '${collabBoard}'::uuid;`).out === "t",
  );
  const decisionInsert = as(owner, `insert into public.decision_records (id, room_id, title, status) values ('${collabDecision}'::uuid, '${capRoom}'::uuid, '已決定：採用 B 版', 'pending');`);
  as(reviewer, `update public.decision_records set status = 'decided' where id = '${collabDecision}'::uuid;`);
  const afterReviewer = as(owner, `select status from public.decision_records where id = '${collabDecision}'::uuid;`).out;
  const ownerFinalize = as(owner, `update public.decision_records set status = 'decided' where id = '${collabDecision}'::uuid;`);
  ok(
    "owner 可以寫決策，reviewer 不能 finalize",
    !decisionInsert.failed && afterReviewer === "pending" && !ownerFinalize.failed
      && as(owner, `select status from public.decision_records where id = '${collabDecision}'::uuid;`).out === "decided",
    [decisionInsert.err, ownerFinalize.err, afterReviewer].filter(Boolean).join(" | "),
  );
  const boardDelete = as(owner, `delete from public.whiteboards where id = '${collabBoard}'::uuid;`);
  const boardArchive = as(owner, `update public.whiteboards set archived_at = now() where id = '${collabBoard}'::uuid;`);
  ok(
    "白板 hard delete 被擋住，只能封存",
    boardDelete.failed && !boardArchive.failed && as(owner, `select archived_at is not null from public.whiteboards where id = '${collabBoard}'::uuid;`).out === "t",
    [boardDelete.err, boardArchive.err].filter(Boolean).join(" | "),
  );
  psql(`set request.jwt.claim.sub = '${owner}';
    select create_room_with_invite('${otherRoom}'::uuid, '另一間房', 'other-collab-token-0001', 'Owner', '#111111');
    insert into public.whiteboards (id, room_id, title) values ('${otherBoard}'::uuid, '${otherRoom}'::uuid, '不該看到');`);
  ok(
    "跨房隔離：reviewer 讀不到另一間房的白板",
    as(reviewer, `select count(*) from public.whiteboards where id = '${otherBoard}'::uuid;`).out === "0",
  );
  ok(
    "get_whiteboard_context 只回結構不回原始媒體",
    as(owner, `select (get_whiteboard_context('${collabBoard}'::uuid)->>'whiteboard') is not null;`).out === "t"
      && !as(owner, `select get_whiteboard_context('${collabBoard}'::uuid)::text;`).out.includes("room-assets"),
  );
  ok("匿名讀不到白板 / 討論 / 決策", asAnon(`select count(*) from public.whiteboards;`).out !== "1" && asAnon(`select count(*) from public.room_discussion_messages;`).out !== "1");

  // -------------------------------------------------------------------------
  // 討論訊息的作者完整性（PR-COMM-00）
  //
  // 0019 的稽核列已經把「actor 冒名」當成必須擋下的類別，同一個房間裡卻可以
  // 用別人的 uid 發討論訊息 — 訊息才是「誰同意了什麼」的原始證據。這組探針
  // 用真實角色（不是超級使用者）直接打資料庫，繞過 client：任何成員都能用
  // supabase-js 送出同樣的 insert。
  // -------------------------------------------------------------------------
  section("討論訊息作者完整性：0014 room_discussion_messages");
  const forgedMsg = psql("select gen_random_uuid();").out;
  const honestMsg = psql("select gen_random_uuid();").out;
  const honest = as(reviewer, `insert into public.room_discussion_messages (id, room_id, author_user_id, author_name, body) values ('${honestMsg}'::uuid, '${capRoom}'::uuid, '${reviewer}'::uuid, 'Reviewer', '我同意 B 版');`);
  ok(
    "成員可以用自己的 uid 發討論訊息",
    !honest.failed,
    honest.err,
  );
  const forge = as(reviewer, `insert into public.room_discussion_messages (id, room_id, author_user_id, author_name, body) values ('${forgedMsg}'::uuid, '${capRoom}'::uuid, '${owner}'::uuid, 'Owner', '我同意 B 版');`);
  ok(
    "冒名發訊息（author_user_id 填別人的 uid）被擋",
    forge.failed,
    forge.failed ? "" : "reviewer 成功以 owner 身分發言 — 決策證據可被偽造",
  );
  const relabel = as(reviewer, `update public.room_discussion_messages set author_user_id = '${owner}'::uuid where id = '${honestMsg}'::uuid;`);
  ok(
    "作者不能把自己的訊息改成別人發的",
    relabel.failed || as(owner, `select author_user_id from public.room_discussion_messages where id = '${honestMsg}'::uuid;`).out === reviewer,
    "編輯訊息不得改變作者",
  );
  const ownerRelabel = as(owner, `update public.room_discussion_messages set author_user_id = '${stranger}'::uuid where id = '${honestMsg}'::uuid;`);
  ok(
    "管理者也不能改寫訊息作者（洗白作者身分）",
    ownerRelabel.failed || as(owner, `select author_user_id from public.room_discussion_messages where id = '${honestMsg}'::uuid;`).out === reviewer,
    "can_manage_media 不該等於可以重寫作者",
  );
  ok(
    "非成員不能對別人的房間發訊息",
    as(stranger, `insert into public.room_discussion_messages (room_id, author_user_id, author_name, body) values ('${capRoom}'::uuid, '${stranger}'::uuid, 'Stranger', '插話');`).failed,
  );
  // 跨房回覆：複合外鍵 (reply_to_id, room_id) 應該擋下「在 B 房回覆 A 房的訊息」。
  // 這條**必須**配一個正向對照：只驗負面的話，任何一種失敗（欄位打錯、
  // 權限不足、SQL 語法錯）都會讓探針變綠 —— 本檔第一版就是欄位數與值數
  // 對不上，於是它每次都「通過」，而且通過的原因跟外鍵毫無關係。
  const crossRoomReply = as(owner, `insert into public.room_discussion_messages (room_id, author_user_id, author_name, body, reply_to_id) values ('${otherRoom}'::uuid, '${owner}'::uuid, 'Owner', '跨房回覆', '${honestMsg}'::uuid);`);
  const sameRoomNoReply = as(owner, `insert into public.room_discussion_messages (room_id, author_user_id, author_name, body) values ('${otherRoom}'::uuid, '${owner}'::uuid, 'Owner', '同一句話但不回覆');`);
  ok(
    "reply_to_id 不能指向別的房間的訊息（且同一句話拿掉 reply_to_id 就寫得進去）",
    crossRoomReply.failed && !sameRoomNoReply.failed,
    crossRoomReply.failed
      ? (sameRoomNoReply.failed ? `正向對照也失敗，所以上面那個失敗不能歸因於外鍵：${sameRoomNoReply.err}` : "")
      : "跨房回覆竟然寫得進去",
  );

  // room_discussion_supports 是討論路徑上唯一一張完全沒有 RLS 探針的表
  // （表情回應就存在這裡）。PK 是 (message_id, user_id)，insert/delete 都綁
  // user_id = auth.uid()。client 的取消支持沒有帶 user_id 篩選，靠的正是
  // 這條 delete policy 把範圍限制在自己那列 —— 沒有探針的話，policy 一旦
  // 鬆掉，「取消自己的支持」會變成「清掉所有人的支持」而沒有人會發現。
  section("表情回應：0014 room_discussion_supports RLS");
  ok(
    "成員可以支持一則訊息（user_id 由 default auth.uid() 填）",
    !as(reviewer, `insert into public.room_discussion_supports (message_id, room_id) values ('${honestMsg}'::uuid, '${capRoom}'::uuid);`).failed,
  );
  ok(
    "同一人同一則不會重複計數（PK 擋住）",
    as(reviewer, `insert into public.room_discussion_supports (message_id, room_id) values ('${honestMsg}'::uuid, '${capRoom}'::uuid);`).failed
      && as(owner, `select count(*) from public.room_discussion_supports where message_id = '${honestMsg}'::uuid;`).out === "1",
  );
  ok(
    "不能以別人的身分支持",
    as(reviewer, `insert into public.room_discussion_supports (message_id, room_id, user_id) values ('${honestMsg}'::uuid, '${capRoom}'::uuid, '${owner}'::uuid);`).failed,
  );
  as(owner, `insert into public.room_discussion_supports (message_id, room_id) values ('${honestMsg}'::uuid, '${capRoom}'::uuid);`);
  // client 端的取消支持是 delete ... eq(message_id).eq(room_id)，**沒有**帶
  // user_id。RLS 必須把它限制在自己那列，否則一個人取消支持會清掉全部。
  as(reviewer, `delete from public.room_discussion_supports where message_id = '${honestMsg}'::uuid and room_id = '${capRoom}'::uuid;`);
  ok(
    "取消支持只會刪掉自己那一列（client 的 delete 沒帶 user_id，靠 RLS 收斂）",
    as(owner, `select count(*) from public.room_discussion_supports where message_id = '${honestMsg}'::uuid;`).out === "1"
      && as(owner, `select count(*) from public.room_discussion_supports where message_id = '${honestMsg}'::uuid and user_id = '${owner}'::uuid;`).out === "1",
  );
  ok(
    "非成員讀不到也寫不了別房的表情回應",
    as(stranger, `select count(*) from public.room_discussion_supports where message_id = '${honestMsg}'::uuid;`).out === "0"
      && as(stranger, `insert into public.room_discussion_supports (message_id, room_id) values ('${honestMsg}'::uuid, '${capRoom}'::uuid);`).failed,
  );
  ok(
    "支持不能指向別的房間的訊息（複合外鍵）",
    as(owner, `insert into public.room_discussion_supports (message_id, room_id) values ('${honestMsg}'::uuid, '${otherRoom}'::uuid);`).failed,
  );

  section("協作工作台：0014 可以重跑");
  const collabShape = () => psql(`select
    (select count(*) from information_schema.tables where table_name in ('whiteboards','whiteboard_nodes','whiteboard_edges','room_discussion_messages','decision_records','voice_sessions')) || '/' ||
    (select count(*) from pg_policies where tablename in ('whiteboards','whiteboard_nodes','whiteboard_edges','room_discussion_messages','decision_records')) || '/' ||
    (select count(*) from pg_trigger where tgname in ('whiteboards_no_delete','whiteboards_touch'));`).out;
  const collabBefore = collabShape();
  psqlFile(join(MIGRATIONS, "0014_collaboration_workspace.sql"));
  const collabAfter = collabShape();
  const [collabTables0, collabPolicies0, collabTriggers0] = collabBefore.split("/");
  const [collabTables1, collabPolicies1, collabTriggers1] = collabAfter.split("/");
  ok(
    "重跑 0014 之後 tables / triggers 不變（0031 已拿掉的 delete policy 可能被 0014 放回）",
    collabTables0 === collabTables1
      && collabTriggers0 === collabTriggers1
      && (collabPolicies0 === collabPolicies1 || Number(collabPolicies1) === Number(collabPolicies0) + 1),
    `${collabBefore} → ${collabAfter}`,
  );
  // 0014 會 drop/create 同名的 room_discussion_insert policy，所以 0022 的
  // 修補若只寫在 policy 上，任何一次 replay 都會把冒名的洞放回來。0022 因此
  // 同時掛 trigger；這裡就是驗那道護欄真的撐過 replay。
  ok(
    "重跑 0014 之後仍然擋得住冒名發訊息（0022 的 trigger 不被 replay 洗掉）",
    as(reviewer, `insert into public.room_discussion_messages (room_id, author_user_id, author_name, body) values ('${capRoom}'::uuid, '${owner}'::uuid, 'Owner', 'replay 之後的冒名');`).failed,
  );
  ok(
    "重跑 0014 之後成員仍然發得出自己的訊息（護欄沒有擋到正常路徑）",
    !as(reviewer, `insert into public.room_discussion_messages (room_id, author_user_id, author_name, body) values ('${capRoom}'::uuid, '${reviewer}'::uuid, 'Reviewer', 'replay 之後的正常發言');`).failed,
  );

  section("素材庫：0016 RLS");
  const libRoom = psql("select gen_random_uuid();").out;
  const libShared = psql("select gen_random_uuid();").out;
  const libRoomInsert = as(owner, `insert into public.library_assets (id, scope, room_id, title, summary, topics, kind) values ('${libRoom}'::uuid, 'room', '${capRoom}'::uuid, '茶會文宣', '春季茶會主視覺', array['茶會'], 'poster');`);
  const libSharedInsert = as(owner, `insert into public.library_assets (id, scope, title, summary, topics, kind) values ('${libShared}'::uuid, 'shared', '社團 Logo', '固定標誌', array['主視覺'], 'image');`);
  ok(
    "owner 可以寫房間素材與共用素材",
    !libRoomInsert.failed && !libSharedInsert.failed,
    `${libRoomInsert.err} | ${libSharedInsert.err}`,
  );
  ok(
    "reviewer 可讀但不能寫 library",
    as(reviewer, `select count(*) from public.library_assets where id = '${libRoom}'::uuid;`).out === "1"
      && as(reviewer, `insert into public.library_assets (scope, room_id, title, kind) values ('room', '${capRoom}'::uuid, 'blocked', 'image');`).failed,
  );
  ok("非成員讀不到房間素材庫", as(stranger, `select count(*) from public.library_assets where id = '${libRoom}'::uuid;`).out === "0");
  const libraryShape = () => psql(`select
    (select count(*) from information_schema.tables where table_name = 'library_assets') || '/' ||
    (select count(*) from pg_policies where tablename = 'library_assets');`).out;
  const libraryBefore = libraryShape();
  psqlFile(join(MIGRATIONS, "0016_asset_library.sql"));
  ok("重跑 0016 後 tables / policies 數量不變", libraryBefore === libraryShape(), `${libraryBefore} → ${libraryShape()}`);

  section("0017：共用素材與提案作者 ACL");
  // 0016 replay recreates the old shared UPDATE/DELETE policies. Re-apply 0017
  // so the author ACL is what we probe, then prove 0017 is itself idempotent.
  psqlFile(join(MIGRATIONS, "0017_author_acl.sql"));
  const stamped = as(owner, `select created_by from public.library_assets where id = '${libShared}'::uuid;`);
  ok(
    "共用素材 insert 會 stamp created_by",
    stamped.out === owner,
    `${stamped.out} vs ${owner}`,
  );
  const editorHijack = as(editor, `update public.library_assets set title = 'hijack' where id = '${libShared}'::uuid returning id;`);
  const afterHijack = as(owner, `select title from public.library_assets where id = '${libShared}'::uuid;`);
  ok(
    "同房 editor 不能改別人建立的共用素材",
    editorHijack.out === "" && afterHijack.out === "社團 Logo",
    `returned=${editorHijack.out} title=${afterHijack.out} err=${editorHijack.err}`,
  );
  ok(
    "建立者仍可更新自己的共用素材",
    !as(owner, `update public.library_assets set title = '社團 Logo 更新' where id = '${libShared}'::uuid;`).failed,
  );
  const ownerProposal = psql("select gen_random_uuid();").out;
  const reviewerProposal = psql("select gen_random_uuid();").out;
  ok(
    "owner 可建立提案",
    !as(owner, `insert into public.visual_proposals (id, room_id, version_id, name, payload) values ('${ownerProposal}'::uuid, '${capRoom}'::uuid, '${capVersion}'::uuid, 'Owner proposal', '{}'::jsonb);`).failed,
  );
  const reviewerSteal = as(reviewer, `update public.visual_proposals set name = 'stolen' where id = '${ownerProposal}'::uuid returning id;`);
  const afterSteal = as(owner, `select name from public.visual_proposals where id = '${ownerProposal}'::uuid;`);
  ok(
    "reviewer 不能直接 UPDATE 別人的提案",
    reviewerSteal.out === "" && afterSteal.out === "Owner proposal",
    `returned=${reviewerSteal.out} name=${afterSteal.out} err=${reviewerSteal.err}`,
  );
  ok(
    "reviewer 可用 upsert 建立自己的提案，但不能覆寫別人的",
    !as(reviewer, `select upsert_visual_proposal('${reviewerProposal}'::uuid, '${capRoom}'::uuid, '${capVersion}'::uuid, 'Reviewer', 'Mine', '{}'::jsonb, null);`).failed
      && as(reviewer, `select upsert_visual_proposal('${ownerProposal}'::uuid, '${capRoom}'::uuid, '${capVersion}'::uuid, 'Reviewer', 'stolen', '{}'::jsonb, 1);`).failed,
  );
  ok(
    "owner 仍可用 upsert 更新自己的提案",
    !as(owner, `select upsert_visual_proposal('${ownerProposal}'::uuid, '${capRoom}'::uuid, '${capVersion}'::uuid, 'Owner', 'Owner proposal 2', '{}'::jsonb, 1);`).failed
      && as(owner, `select name from public.visual_proposals where id = '${ownerProposal}'::uuid;`).out === "Owner proposal 2",
  );
  const aclShape = () => psql(`select
    (select count(*) from pg_policies where tablename = 'visual_proposals') || '/' ||
    (select count(*) from pg_policies where tablename = 'library_assets') || '/' ||
    (select count(*) from pg_trigger where tgname = 'library_assets_stamp_author');`).out;
  const aclBefore = aclShape();
  psqlFile(join(MIGRATIONS, "0017_author_acl.sql"));
  ok("重跑 0017 後 policies / trigger 數量不變", aclBefore === aclShape(), `${aclBefore} → ${aclShape()}`);

  section("0018：討論附件與 library insert 殘洞");
  // 上面 0016→0017 的 replay 舞步把舊的 library_assets_insert 復活了；
  // 0018 必須在它們之後重套（真實升級也一樣：任何 0016/0017 replay 之後
  // 都要補跑 0018）。
  psqlFile(join(MIGRATIONS, "0018_discussion_attachments.sql"));

  // (a) 訊息 kind 與 payload 衛生
  const attMsg = psql("select gen_random_uuid();").out;
  const attPath = `rooms/${capRoom}/attachments/${attMsg}/att1.pdf`;
  ok(
    "owner 可發 attachment 訊息（path+mime 齊備）",
    !as(owner, `insert into public.room_discussion_messages (id, room_id, author_name, kind, body, payload) values ('${attMsg}'::uuid, '${capRoom}'::uuid, 'Owner', 'attachment', 'brief.pdf', '{"path":"${attPath}","mime":"application/pdf","size":12345,"name":"brief.pdf"}'::jsonb);`).failed,
  );
  ok(
    "沒有 path 的 attachment 被 payload 約束擋下",
    as(owner, `insert into public.room_discussion_messages (room_id, author_name, kind, body, payload) values ('${capRoom}'::uuid, 'Owner', 'attachment', 'x', '{"mime":"application/pdf"}'::jsonb);`).failed,
  );
  ok(
    "沒有 href 的 link 被 payload 約束擋下",
    as(owner, `insert into public.room_discussion_messages (room_id, author_name, kind, body, payload) values ('${capRoom}'::uuid, 'Owner', 'link', 'x', '{}'::jsonb);`).failed,
  );
  ok(
    "亂寫的 kind 仍然被 CHECK 擋下",
    as(owner, `insert into public.room_discussion_messages (room_id, author_name, kind, body) values ('${capRoom}'::uuid, 'Owner', 'bogus', 'x');`).failed,
  );
  const reviewerAttMsg = psql("select gen_random_uuid();").out;
  const reviewerAttPath = `rooms/${capRoom}/attachments/${reviewerAttMsg}/r1.pdf`;
  ok(
    "reviewer 也能發 attachment 與 link 訊息",
    !as(reviewer, `insert into public.room_discussion_messages (id, room_id, author_name, kind, body, payload) values ('${reviewerAttMsg}'::uuid, '${capRoom}'::uuid, 'Reviewer', 'attachment', 'r1.pdf', '{"path":"${reviewerAttPath}","mime":"application/pdf"}'::jsonb);`).failed
      && !as(reviewer, `insert into public.room_discussion_messages (room_id, author_name, kind, body, payload) values ('${capRoom}'::uuid, 'Reviewer', 'link', 'https://example.com', '{"href":"https://example.com"}'::jsonb);`).failed,
  );

  // (b) storage：attachments 前綴成員可寫、add-only；其他前綴不得被 OR 放寬
  ok(
    "reviewer 可以上傳 attachments 前綴的物件",
    !as(reviewer, `insert into storage.objects (bucket_id, name) values ('room-assets', '${reviewerAttPath}');`).failed,
  );
  ok(
    "reviewer 仍然不能寫 versions/videos/proposals 前綴（新 policy 沒有 OR 放寬舊界線）",
    as(reviewer, `insert into storage.objects (bucket_id, name) values ('room-assets', 'rooms/${capRoom}/videos/${capVersion}/sneak.mp4');`).failed
      && as(reviewer, `insert into storage.objects (bucket_id, name) values ('room-assets', 'rooms/${capRoom}/versions/${capVersion}/sneak.png');`).failed,
  );
  ok(
    "非成員不能寫別房的 attachments 前綴",
    as(stranger, `insert into storage.objects (bucket_id, name) values ('room-assets', 'rooms/${capRoom}/attachments/${attMsg}/sneak.pdf');`).failed,
  );
  as(reviewer, `update storage.objects set name = '${reviewerAttPath}.moved' where bucket_id = 'room-assets' and name = '${reviewerAttPath}';`);
  as(reviewer, `delete from storage.objects where bucket_id = 'room-assets' and name = '${reviewerAttPath}';`);
  ok(
    "附件 add-only：上傳者（reviewer）不能改名或刪除自己的附件物件",
    psql(`select name from storage.objects where bucket_id = 'room-assets' and name = '${reviewerAttPath}';`).out === reviewerAttPath,
  );
  ok(
    "editor（can_manage_media）仍可清理附件物件",
    !as(editor, `delete from storage.objects where bucket_id = 'room-assets' and name = '${reviewerAttPath}';`).failed
      && psql(`select count(*) from storage.objects where bucket_id = 'room-assets' and name = '${reviewerAttPath}';`).out === "0",
  );
  ok(
    "room-assets bucket 仍是 private",
    psql(`select public from storage.buckets where id = 'room-assets';`).out === "f",
  );

  // (c) 附件不進孤兒盤點（0009 只掃 versions/videos — 附件由討論 payload 參照）
  const orphanCheckPath = `rooms/${capRoom}/attachments/${attMsg}/att1.pdf`;
  psql(`insert into storage.objects (bucket_id, name, created_at) values ('room-assets', '${orphanCheckPath}', now() - interval '2 days') on conflict do nothing;`);
  ok(
    "attachments 物件不會被 orphaned_room_assets 盤成孤兒",
    psql(`select count(*) from public.orphaned_room_assets(interval '0 seconds') where name = '${orphanCheckPath}';`).out === "0",
  );

  // (d) library_assets shared-insert 殘洞：冒名 created_by 被 policy 擋下
  ok(
    "shared insert 冒名 created_by 被擋、本人/留空可過",
    as(editor, `insert into public.library_assets (scope, title, kind, created_by) values ('shared', 'spoof', 'image', '${owner}'::uuid);`).failed
      && !as(editor, `insert into public.library_assets (scope, title, kind) values ('shared', '編輯者的共用素材', 'image');`).failed,
  );
  // 0017 的 editor-hijack 保護在 0018 重套後仍成立
  const hijackAgain = as(editor, `update public.library_assets set title = 'hijack2' where id = '${libShared}'::uuid returning id;`);
  ok("0018 之後 0017 的作者 ACL 仍成立", hijackAgain.out === "");

  // (e) 冪等：重跑 0018 後 constraint / policy 形狀不變；0014 replay 不會復活舊 kind CHECK
  const attachShape = () => psql(`select
    (select count(*) from pg_policies where tablename = 'objects' and policyname = 'room_assets_attachments_insert') || '/' ||
    (select count(*) from pg_policies where tablename = 'library_assets') || '/' ||
    (select count(*) from pg_constraint where conname in ('room_discussion_messages_kind_check','room_discussion_attachment_payload'));`).out;
  const attachBefore = attachShape();
  psqlFile(join(MIGRATIONS, "0018_discussion_attachments.sql"));
  ok("重跑 0018 後 policy / constraint 形狀不變", attachBefore === attachShape(), `${attachBefore} → ${attachShape()}`);
  psqlFile(join(MIGRATIONS, "0014_collaboration_workspace.sql"));
  ok(
    "0014 replay 之後 attachment kind 仍可寫（create table if not exists 不會復活舊 CHECK）",
    !as(owner, `insert into public.room_discussion_messages (room_id, author_name, kind, body, payload) values ('${capRoom}'::uuid, 'Owner', 'attachment', 'again.pdf', '{"path":"rooms/${capRoom}/attachments/${attMsg}/again.pdf","mime":"application/pdf"}'::jsonb);`).failed,
  );

  section("0019：AI 套用稽核事件");
  psqlFile(join(MIGRATIONS, "0019_ai_apply_audit.sql"));

  // (a) 成員可寫自己的 ai_proposal_applied
  ok(
    "owner 可寫 ai_proposal_applied（actor=自己）",
    !as(owner, `insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload) values ('${capRoom}'::uuid, 'ai_proposal_applied', '${owner}'::uuid, '{"proposal_id":"p1","type":"create_poll","label":"投票"}'::jsonb);`).failed,
  );
  // (b) 偽造 actor 被 policy 擋下
  ok(
    "actor 冒名（別人的 uid）被擋",
    as(owner, `insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload) values ('${capRoom}'::uuid, 'ai_proposal_applied', '${stranger}'::uuid, '{}'::jsonb);`).failed,
  );
  // (c) trigger 專屬型別不可被 client 偽造
  ok(
    "client 不能偽造 decision_finalized（trigger 專屬型別）",
    as(owner, `insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload) values ('${capRoom}'::uuid, 'decision_finalized', '${owner}'::uuid, '{}'::jsonb);`).failed,
  );
  // (d) 非成員不能寫別房的稽核
  ok(
    "非成員不能寫別房的 ai_proposal_applied",
    as(stranger, `insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload) values ('${capRoom}'::uuid, 'ai_proposal_applied', '${stranger}'::uuid, '{}'::jsonb);`).failed,
  );
  // (e) append-only：沒有 update / delete 授權
  ok(
    "稽核列 append-only（update 無授權）",
    as(owner, `update public.collaboration_audit_events set payload = '{}'::jsonb where room_id = '${capRoom}'::uuid;`).failed,
  );
  ok(
    "稽核列 append-only（delete 無授權）",
    as(owner, `delete from public.collaboration_audit_events where room_id = '${capRoom}'::uuid;`).failed,
  );
  // (e2) actor NULL：with check 三值邏輯只收 true，NULL 被擋（Grok 04 F1）
  ok(
    "actor_user_id NULL 被 with check 擋下",
    as(owner, `insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload) values ('${capRoom}'::uuid, 'ai_proposal_applied', null, '{}'::jsonb);`).failed,
  );
  // (e3) anon 完全進不來（0014 revoke all from anon）
  ok(
    "anon 不能寫稽核列",
    asAnon(`insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload) values ('${capRoom}'::uuid, 'ai_proposal_applied', null, '{}'::jsonb);`).failed,
  );
  ok(
    "anon 不能讀稽核列",
    asAnon(`select count(*) from public.collaboration_audit_events;`).failed,
  );
  // (f) select 仍是成員限定
  ok(
    "owner 讀得到自己房的稽核列（列確實存在）",
    Number(as(owner, `select count(*) from public.collaboration_audit_events where room_id = '${capRoom}'::uuid;`).out) >= 1,
  );
  ok(
    "非成員讀不到稽核列（同一張非空表 — 是 RLS 濾掉，不是空表偽陰）",
    as(stranger, `select count(*) from public.collaboration_audit_events where room_id = '${capRoom}'::uuid;`).out === "0",
  );
  // (g) 冪等＋0014 replay 不復活舊 CHECK
  const auditShape = () => psql(`select
    (select count(*) from pg_policies where tablename = 'collaboration_audit_events') || '/' ||
    (select count(*) from pg_constraint where conname = 'collaboration_audit_events_event_type_check');`).out;
  const auditBefore = auditShape();
  psqlFile(join(MIGRATIONS, "0019_ai_apply_audit.sql"));
  ok("重跑 0019 後 policy / constraint 形狀不變", auditBefore === auditShape(), `${auditBefore} → ${auditShape()}`);
  psqlFile(join(MIGRATIONS, "0014_collaboration_workspace.sql"));
  ok(
    "0014 replay 之後 ai_proposal_applied 仍可寫（CHECK 不復活、grant 不被撤銷）",
    !as(owner, `insert into public.collaboration_audit_events (room_id, event_type, actor_user_id, payload) values ('${capRoom}'::uuid, 'ai_proposal_applied', '${owner}'::uuid, '{"proposal_id":"p2","type":"add_whiteboard_node","label":"再套一次"}'::jsonb);`).failed,
  );

  section("0020：Canva token 表對 client 完全不可見");
  psqlFile(join(MIGRATIONS, "0020_canva_bridge.sql"));

  // token 表：RLS 開、零 policy、grant 全收 — authenticated 連 select 都
  // 是 permission denied（不是 RLS 濾成空集，是表層拒絕）。
  ok("成員讀不到 canva_connections（permission denied）", as(owner, `select count(*) from public.canva_connections;`).failed);
  ok("成員寫不進 canva_connections", as(owner, `insert into public.canva_connections (user_id, access_token, refresh_token, token_expires_at) values ('${owner}'::uuid, 'x', 'y', now());`).failed);
  ok("anon 讀不到 canva_connections", asAnon(`select count(*) from public.canva_connections;`).failed);
  ok("成員讀不到 canva_oauth_states", as(owner, `select count(*) from public.canva_oauth_states;`).failed);
  ok("成員寫不進 canva_oauth_states", as(owner, `insert into public.canva_oauth_states (state, user_id, code_verifier) values ('s1', '${owner}'::uuid, 'v');`).failed);
  // service role（superuser 代演）照常讀寫 — bridge 的權威路徑。
  ok(
    "service 路徑可寫可讀 token 列",
    !psql(`insert into public.canva_connections (user_id, access_token, refresh_token, token_expires_at) values ('${owner}'::uuid, 'at', 'rt', now() + interval '4 hours');`).failed &&
      psql(`select count(*) from public.canva_connections where user_id = '${owner}'::uuid;`).out === "1",
  );
  // 冪等：重跑不炸、RLS 不被關回去。
  const canvaShape = () => psql(`select
    (select relrowsecurity from pg_class where relname = 'canva_connections') || '/' ||
    (select relrowsecurity from pg_class where relname = 'canva_oauth_states') || '/' ||
    (select count(*) from pg_policies where tablename in ('canva_connections','canva_oauth_states'));`).out;
  const canvaBefore = canvaShape();
  psqlFile(join(MIGRATIONS, "0020_canva_bridge.sql"));
  ok("重跑 0020 後 RLS / policy 形狀不變（true/true/0）", canvaBefore === canvaShape() && canvaBefore === "true/true/0", `${canvaBefore} → ${canvaShape()}`);
  ok("重跑後成員依然讀不到 token 表", as(owner, `select count(*) from public.canva_connections;`).failed);

  section("0023 影片最佳化欄位");
  ok(
    "versions 有 optimized_video_path / source_file_size / optimized",
    psql(`select count(*) from information_schema.columns where table_name = 'versions' and column_name in ('optimized_video_path','source_file_size','optimized');`).out === "3",
  );
  const optimizeShape = () => psql(`select count(*) from information_schema.columns where table_name = 'versions' and column_name in ('optimized_video_path','source_file_size','optimized');`).out;
  const optimizeBefore = optimizeShape();
  psqlFile(join(MIGRATIONS, "0023_video_optimize.sql"));
  ok("0023 可以重複套用且欄位數不變", optimizeBefore === optimizeShape() && optimizeBefore === "3", `${optimizeBefore} → ${optimizeShape()}`);

  section("0024–0028：canonical whiteboard schema（WB01）");
  psqlFile(join(MIGRATIONS, "0024_whiteboard_canonical_columns.sql"));
  psqlFile(join(MIGRATIONS, "0025_whiteboard_frames.sql"));
  psqlFile(join(MIGRATIONS, "0026_whiteboard_operations.sql"));
  psqlFile(join(MIGRATIONS, "0027_whiteboard_versions.sql"));

  // (a) NOT VALID 約束必須真的 validate 過（Grok wb00 F4：只驗存在會假綠）
  ok(
    "link_pair 與 parent_group_fk 均 convalidated",
    psql(`select bool_and(convalidated) from pg_constraint where conname in ('whiteboard_nodes_link_pair','whiteboard_nodes_parent_group_fk');`).out === "t",
  );

  // (b) z_index 不變式（Grok wb00 F5）：node >= 0、frame < 0
  ok("node z_index < 0 被 CHECK 擋下", as(owner, `insert into public.whiteboard_nodes (whiteboard_id, room_id, node_type, content, z_index) values ('${collabBoard}'::uuid, '${capRoom}'::uuid, 'text', '{}'::jsonb, -1);`).failed);
  const wbFrame = psql("select gen_random_uuid();").out;
  ok("frame z_index >= 0 被 CHECK 擋下", as(owner, `insert into public.whiteboard_frames (id, whiteboard_id, room_id, title, z_index) values ('${wbFrame}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, '規劃區', 0);`).failed);
  ok("合法 frame 建得起來（owner）", !as(owner, `insert into public.whiteboard_frames (id, whiteboard_id, room_id, title) values ('${wbFrame}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, '規劃區');`).failed);
  ok("rotation 超界被 CHECK 擋下", as(owner, `update public.whiteboard_nodes set rotation = 361 where id = '${collabNode}'::uuid;`).failed);

  // (c) edges OCC（0021 補；先前 edges 零 OCC）
  const occEdgeA = psql("select gen_random_uuid();").out;
  const occNodeB = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}';
    insert into public.whiteboard_nodes (id, whiteboard_id, room_id, node_type, content) values ('${occNodeB}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, 'text', '{}'::jsonb);
    insert into public.whiteboard_edges (id, whiteboard_id, room_id, source_node_id, target_node_id, edge_type) values ('${occEdgeA}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, '${collabNode}'::uuid, '${occNodeB}'::uuid, 'default');`);
  ok("edge 正常 update 會被 trigger 進版", !as(owner, `update public.whiteboard_edges set label = '流程' where id = '${occEdgeA}'::uuid;`).failed && as(owner, `select version from public.whiteboard_edges where id = '${occEdgeA}'::uuid;`).out === "2");
  ok("edge stale-write 被擋（version 倒退）", as(owner, `update public.whiteboard_edges set label = 'x', version = 1 where id = '${occEdgeA}'::uuid;`).failed);
  ok("edge handle 詞彙外被 CHECK 擋下", as(owner, `update public.whiteboard_edges set source_handle = 'diagonal' where id = '${occEdgeA}'::uuid;`).failed);

  // (d) tombstone：soft-delete 走 OCC；REST 硬刪已被 revoke
  const tombNode = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}'; insert into public.whiteboard_nodes (id, whiteboard_id, room_id, node_type, content) values ('${tombNode}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, 'text', '{"text":"要刪的"}'::jsonb);`);
  ok("soft-delete 帶過期 version 走 stale-write（ADR-011 關閉）", as(owner, `update public.whiteboard_nodes set deleted_at = now(), version = 0 where id = '${tombNode}'::uuid;`).failed);
  ok("soft-delete 帶當前 version 成功", !as(owner, `update public.whiteboard_nodes set deleted_at = now(), version = (select version from public.whiteboard_nodes where id = '${tombNode}'::uuid) where id = '${tombNode}'::uuid;`).failed);
  ok("authenticated 的 REST 硬刪被 revoke", as(owner, `delete from public.whiteboard_nodes where id = '${tombNode}'::uuid;`).failed);
  // get_whiteboard_context 不回墓碑（Grok wb00 F8 repro 5）
  const ctxAfter = as(owner, `select public.get_whiteboard_context('${collabBoard}'::uuid)::text;`).out;
  ok("get_whiteboard_context 不含墓碑節點", !ctxAfter.includes(tombNode));
  ok("get_whiteboard_context 仍含活節點", ctxAfter.includes(collabNode));
  // 第二條 AI 讀路（Grok wb01 F3 抓漏的 get_selected_board_context）
  const selCtx = as(owner, `select public.get_selected_board_context('${collabBoard}'::uuid, array['${tombNode}','${collabNode}']::uuid[])::text;`).out;
  ok("get_selected_board_context 不含墓碑節點", !selCtx.includes(tombNode));
  ok("get_selected_board_context 仍含活節點", selCtx.includes(collabNode));
  // frames 真的在 realtime publication 裡（Grok wb01 F4：shape 沒量到）
  ok(
    "whiteboard_frames 已加入 supabase_realtime publication",
    psql(`select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'whiteboard_frames';`).out === "1",
  );
  // 0024 snapshot CHECK：缺 edges 陣列被拒（設計如此 — Grok wb01 F8c 記錄）
  ok("快照缺 edges 陣列被 CHECK 擋下", as(owner, `insert into public.whiteboard_versions (id, whiteboard_id, room_id, snapshot, created_by) values (gen_random_uuid(), '${collabBoard}'::uuid, '${capRoom}'::uuid, '{"nodes":[]}'::jsonb, '${owner}'::uuid);`).failed);

  // (e) group 環防護（Grok wb00 F4：FK 不防 A↔B）
  const cycA = psql("select gen_random_uuid();").out;
  const cycB = psql("select gen_random_uuid();").out;
  psql(`set request.jwt.claim.sub = '${owner}';
    insert into public.whiteboard_nodes (id, whiteboard_id, room_id, node_type, content) values
      ('${cycA}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, 'group', '{}'::jsonb),
      ('${cycB}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, 'group', '{}'::jsonb);
    update public.whiteboard_nodes set parent_group_id = '${cycA}'::uuid, version = version where id = '${cycB}'::uuid;`);
  ok("group 環（A↔B）被 trigger 擋下", as(owner, `update public.whiteboard_nodes set parent_group_id = '${cycB}'::uuid, version = (select version from public.whiteboard_nodes where id = '${cycA}'::uuid) where id = '${cycA}'::uuid;`).failed);

  // (f) operations：append-only＋actor 冒名＋op_id 冪等＋reviewer 兩態
  const wbOp = psql("select gen_random_uuid();").out;
  ok(
    "owner 可寫 operation（actor=自己）",
    !as(owner, `insert into public.whiteboard_operations (op_id, whiteboard_id, room_id, actor_user_id, op_type, entity_id, field_mask, before, after) values ('${wbOp}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, '${owner}'::uuid, 'node-move', '${collabNode}'::uuid, '{x,y}', '{"x":20}'::jsonb, '{"x":40}'::jsonb);`).failed,
  );
  ok("重複 op_id 被 unique 擋下（重試冪等的 DB 半邊）", as(owner, `insert into public.whiteboard_operations (op_id, whiteboard_id, room_id, actor_user_id, op_type, entity_id) values ('${wbOp}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, '${owner}'::uuid, 'node-move', '${collabNode}'::uuid);`).failed);
  ok("actor 冒名（別人的 uid）被擋", as(owner, `insert into public.whiteboard_operations (op_id, whiteboard_id, room_id, actor_user_id, op_type, entity_id) values (gen_random_uuid(), '${collabBoard}'::uuid, '${capRoom}'::uuid, '${stranger}'::uuid, 'node-move', '${collabNode}'::uuid);`).failed);
  ok("operations append-only（update 無授權）", as(owner, `update public.whiteboard_operations set field_mask = '{}' where op_id = '${wbOp}'::uuid;`).failed);
  ok("operations append-only（delete 無授權）", as(owner, `delete from public.whiteboard_operations where op_id = '${wbOp}'::uuid;`).failed);
  // reviewer 兩態（Grok wb00 F8：allow_board_edit 的真實語意）— 此刻 capRoom 為 true
  ok(
    "allow_board_edit=true 時 reviewer 可寫 operation（actor=自己）",
    !as(reviewer, `insert into public.whiteboard_operations (op_id, whiteboard_id, room_id, actor_user_id, op_type, entity_id) values (gen_random_uuid(), '${collabBoard}'::uuid, '${capRoom}'::uuid, '${reviewer}'::uuid, 'node-update', '${collabNode}'::uuid);`).failed,
  );
  psql(`set request.jwt.claim.sub = '${owner}'; update public.rooms set allow_board_edit = false where id = '${capRoom}'::uuid;`);
  ok(
    "allow_board_edit=false 時 reviewer 寫 operation 被拒",
    as(reviewer, `insert into public.whiteboard_operations (op_id, whiteboard_id, room_id, actor_user_id, op_type, entity_id) values (gen_random_uuid(), '${collabBoard}'::uuid, '${capRoom}'::uuid, '${reviewer}'::uuid, 'node-update', '${collabNode}'::uuid);`).failed,
  );
  psql(`set request.jwt.claim.sub = '${owner}'; update public.rooms set allow_board_edit = true where id = '${capRoom}'::uuid;`);
  ok("stranger 讀不到 operations（RLS 濾掉非空表）", as(stranger, `select count(*) from public.whiteboard_operations;`).out === "0");
  ok("anon 讀不到 operations", asAnon(`select count(*) from public.whiteboard_operations;`).failed);

  // (g) versions：不可變快照＋shape CHECK
  const wbVer = psql("select gen_random_uuid();").out;
  ok(
    "owner 可建快照（created_by=自己）",
    !as(owner, `insert into public.whiteboard_versions (id, whiteboard_id, room_id, label, snapshot, created_by) values ('${wbVer}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, '定稿前', '{"nodes":[],"edges":[]}'::jsonb, '${owner}'::uuid);`).failed,
  );
  ok("快照 shape 不合（nodes 非陣列）被 CHECK 擋下", as(owner, `insert into public.whiteboard_versions (id, whiteboard_id, room_id, snapshot, created_by) values (gen_random_uuid(), '${collabBoard}'::uuid, '${capRoom}'::uuid, '{"nodes":{}}'::jsonb, '${owner}'::uuid);`).failed);
  ok("快照不可變（update 無授權）", as(owner, `update public.whiteboard_versions set label = '改名' where id = '${wbVer}'::uuid;`).failed);
  ok("stranger 讀不到快照", as(stranger, `select count(*) from public.whiteboard_versions;`).out === "0");

  // (h) frames RLS：stranger/anon 全拒
  ok("stranger 不能建 frame", as(stranger, `insert into public.whiteboard_frames (whiteboard_id, room_id, title) values ('${collabBoard}'::uuid, '${capRoom}'::uuid, 'x');`).failed);
  ok("anon 讀不到 frames", asAnon(`select count(*) from public.whiteboard_frames;`).failed);
  ok("frame 正常 update 進版（OCC trigger）", !as(owner, `update public.whiteboard_frames set title = '重規劃' where id = '${wbFrame}'::uuid;`).failed && as(owner, `select version from public.whiteboard_frames where id = '${wbFrame}'::uuid;`).out === "2");

  // (i) 冪等重跑：shape 不變（含 convalidated 仍為 t）
  const wbShape = () => psql(`select
    (select count(*) from pg_policies where tablename in ('whiteboard_frames','whiteboard_operations','whiteboard_versions')) || '/' ||
    (select bool_and(convalidated) from pg_constraint where conname in ('whiteboard_nodes_link_pair','whiteboard_nodes_parent_group_fk')) || '/' ||
    (select count(*) from pg_trigger where tgname in ('whiteboard_edges_touch','whiteboard_frames_touch','whiteboard_nodes_group_cycle'));`).out;
  const wbBefore = wbShape();
  psqlFile(join(MIGRATIONS, "0024_whiteboard_canonical_columns.sql"));
  psqlFile(join(MIGRATIONS, "0025_whiteboard_frames.sql"));
  psqlFile(join(MIGRATIONS, "0026_whiteboard_operations.sql"));
  psqlFile(join(MIGRATIONS, "0027_whiteboard_versions.sql"));
  ok("重跑 0024–0028 後 shape 不變（9/true/3）", wbBefore === wbShape() && wbBefore === "9/true/3", `${wbBefore} → ${wbShape()}`);
  ok("重跑後 REST 硬刪依然被 revoke", as(owner, `delete from public.whiteboard_nodes where id = '${tombNode}'::uuid;`).failed);

  section("0026：freehand 詞彙（WB03）");
  psqlFile(join(MIGRATIONS, "0028_whiteboard_freehand.sql"));
  const fhNode = psql("select gen_random_uuid();").out;
  ok("freehand 節點可插入", !as(owner, `insert into public.whiteboard_nodes (id, whiteboard_id, room_id, node_type, content) values ('${fhNode}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, 'freehand', '{"points":[[0,0],[10,10]]}'::jsonb);`).failed);
  ok("詞彙外型別仍被 CHECK 擋下", as(owner, `insert into public.whiteboard_nodes (whiteboard_id, room_id, node_type, content) values ('${collabBoard}'::uuid, '${capRoom}'::uuid, 'scribble', '{}'::jsonb);`).failed);
  // 0014 重放不得把 'freehand' 洗掉（inline CHECK 只在 create table 生效）
  psqlFile(join(MIGRATIONS, "0014_collaboration_workspace.sql"));
  const fhNode2 = psql("select gen_random_uuid();").out;
  ok("0014 重放後 freehand 仍可插入", !as(owner, `insert into public.whiteboard_nodes (id, whiteboard_id, room_id, node_type, content) values ('${fhNode2}'::uuid, '${collabBoard}'::uuid, '${capRoom}'::uuid, 'freehand', '{}'::jsonb);`).failed);
  // 0026 重放冪等
  psqlFile(join(MIGRATIONS, "0028_whiteboard_freehand.sql"));
  ok("0026 重放後 CHECK 恰一條", psql(`select count(*) from pg_constraint where conname = 'whiteboard_nodes_node_type_check';`).out === "1");
  ok("0026 重放後 freehand 列仍在", psql(`select count(*) from public.whiteboard_nodes where id in ('${fhNode}'::uuid,'${fhNode2}'::uuid);`).out === "2");

  section("0029：設計知識庫（兩段式授權）");
  psqlFile(join(MIGRATIONS, "0029_design_knowledge.sql"));

  // (a) seed：通用知識進得去，而且是 approved
  ok(
    "seed 的通用設計知識存在且為 approved",
    psql(`select count(*) from public.design_knowledge where project_specific is null and status = 'approved';`).out === "7",
    psql(`select count(*) from public.design_knowledge where project_specific is null;`).out,
  );

  // (b) 讀：通用知識任何登入者都讀得到（設計原則每個房間都需要）
  ok("成員讀得到通用知識", Number(as(owner, `select count(*) from public.design_knowledge where project_specific is null;`).out) >= 7);
  ok("非本房成員也讀得到通用知識", Number(as(reviewer, `select count(*) from public.design_knowledge where project_specific is null;`).out) >= 7);
  // `!== "7"` 是假綠：anon 讀到 1 列專案規範也會通過，seed 變 8 列後全讀到也通過。
  ok("anon 讀不到任何知識", asAnon(`select count(*) from public.design_knowledge;`).out === "0" || asAnon(`select count(*) from public.design_knowledge;`).failed);

  // (c) 寫：**通用知識沒有 client 政策** — 任何登入者都寫不進去。
  // 這是本表最重要的一條：讓任何人寫全域知識＝讓任何人污染所有房間的 AI 判斷依據。
  ok(
    "登入者寫不進通用知識（project_specific is null）",
    as(owner, `insert into public.design_knowledge (category, title, summary, rules, content_hash, created_by) values ('color', '我的規則', '摘要', array['規則'], 'hash-global-attack', '${owner}'::uuid);`).failed,
  );

  // (d) 專案規範：owner 寫得進、reviewer 寫不進（沿用 can_manage_media）
  ok(
    "owner 寫得進自己房間的專案規範",
    !as(owner, `insert into public.design_knowledge (category, title, summary, rules, project_specific, created_by) values ('brand-rules', '品牌主色', '摘要', array['主色 #6157ef'], '${capRoom}'::uuid, '${owner}'::uuid);`).failed,
  );
  ok(
    "reviewer 寫不進專案規範（can_manage_media 擋下）",
    as(reviewer, `insert into public.design_knowledge (category, title, summary, rules, project_specific, created_by) values ('brand-rules', 'reviewer 想寫', '摘要', array['規則'], '${capRoom}'::uuid, '${reviewer}'::uuid);`).failed,
  );
  ok("房內成員讀得到專案規範", as(reviewer, `select count(*) from public.design_knowledge where project_specific = '${capRoom}'::uuid;`).out === "1");

  // (e) created_by 必須是自己 — 不能冒名寫入
  ok(
    "不能以別人的身分寫專案規範",
    as(owner, `insert into public.design_knowledge (category, title, summary, rules, project_specific, created_by) values ('brand-rules', '冒名', '摘要', array['規則'], '${capRoom}'::uuid, '${reviewer}'::uuid);`).failed,
  );

  // (f) 機器研究的結果不得自稱 approved／project（DB 層的第二道，client 驗證擋不住直接打 REST 的）
  ok(
    "machine-researched 不得自稱 approved（CHECK 擋下）",
    as(owner, `insert into public.design_knowledge (category, title, summary, rules, project_specific, created_by, status, trust_level) values ('color', '搜來的', '摘要', array['規則'], '${capRoom}'::uuid, '${owner}'::uuid, 'machine-researched', 'approved');`).failed,
  );
  ok(
    "trust_level='project' 必須真的屬於某個專案",
    psql(`insert into public.design_knowledge (category, title, summary, rules, trust_level) values ('color', '無主專案規範', '摘要', array['規則'], 'project');`, { expectError: true }).failed,
  );

  // (g) rules 是核心：空陣列與空字串規則都不算知識
  ok(
    "沒有規則的條目寫不進去",
    psql(`insert into public.design_knowledge (category, title, summary, rules) values ('color', '空規則', '摘要', array[]::text[]);`, { expectError: true }).failed,
  );
  ok(
    "規則裡有空字串也寫不進去",
    psql(`insert into public.design_knowledge (category, title, summary, rules) values ('color', '空字串規則', '摘要', array['', '有內容']);`, { expectError: true }).failed,
  );

  // (h) content_hash 由 trigger 算，呼叫端提供的值一律被覆寫。
  // 否則寫入端可以宣稱「我跟那條已審查的知識內容相同」來繞過判重。
  const forgedHash = "0000forged0000";
  ok(
    "呼叫端提供的 content_hash 被覆寫",
    !as(owner, `insert into public.design_knowledge (category, title, summary, rules, content_hash, project_specific, created_by) values ('brand-rules', '想偽造雜湊', '摘要', array['規則'], '${forgedHash}', '${capRoom}'::uuid, '${owner}'::uuid);`).failed &&
      psql(`select count(*) from public.design_knowledge where content_hash = '${forgedHash}';`).out === "0",
  );

  // (i) 判重：同範圍、同 category、**同內容**只能有一列（內容決定雜湊）
  ok(
    "同一專案同內容不重複收錄",
    as(owner, `insert into public.design_knowledge (category, title, summary, rules, project_specific, created_by) values ('brand-rules', '品牌主色', '摘要', array['主色 #6157ef'], '${capRoom}'::uuid, '${owner}'::uuid);`).failed,
  );
  ok(
    "同一專案不同內容可以並存",
    !as(owner, `insert into public.design_knowledge (category, title, summary, rules, project_specific, created_by) values ('brand-rules', '品牌副色', '摘要', array['副色 #ff9f1c'], '${capRoom}'::uuid, '${owner}'::uuid);`).failed,
  );

  // (j) version 只進不退（touch trigger）
  const knId = psql(`select id from public.design_knowledge where title = '品牌主色';`).out;
  ok(
    "更新後 version 自動前進",
    !as(owner, `update public.design_knowledge set summary = '改過的摘要' where id = '${knId}'::uuid;`).failed &&
      psql(`select version from public.design_knowledge where id = '${knId}'::uuid;`).out === "2",
  );
  ok(
    "version 倒退被 trigger 擋下",
    as(owner, `update public.design_knowledge set summary = 'x', version = 1 where id = '${knId}'::uuid;`).failed,
  );

  // (l) 跨房：非成員讀不到、也刪不掉別人房間的專案規範。
  //
  // 這一組是對抗審查指出的假綠補洞：原本沒有任何 stranger 的負例，
  // 把 SELECT 政策改成 using (true)、或把 DELETE 的 can_manage_media 拿掉，
  // 現有斷言全都還是綠的。
  ok(
    "非成員讀不到別房的專案規範",
    as(stranger, `select count(*) from public.design_knowledge where project_specific = '${capRoom}'::uuid;`).out === "0",
  );
  ok(
    "非成員刪不掉別房的專案規範",
    as(stranger, `delete from public.design_knowledge where project_specific = '${capRoom}'::uuid;`).failed ||
      psql(`select count(*) from public.design_knowledge where project_specific = '${capRoom}'::uuid;`).out !== "0",
  );
  ok(
    "reviewer 刪不掉專案規範（can_manage_media 擋下）",
    as(reviewer, `delete from public.design_knowledge where project_specific = '${capRoom}'::uuid;`).failed ||
      psql(`select count(*) from public.design_knowledge where project_specific = '${capRoom}'::uuid;`).out !== "0",
  );
  ok(
    "非成員改不掉別房的專案規範",
    as(stranger, `update public.design_knowledge set summary = '被改掉了' where project_specific = '${capRoom}'::uuid;`).failed ||
      psql(`select count(*) from public.design_knowledge where summary = '被改掉了';`).out === "0",
  );

  // (m) 只有空白的規則也不算規則（array[' '] 的 cardinality 是 1，
  // 而 array_position 抓不到「只有空白」—— 對抗審查實測到的洞）。
  for (const [label, literal] of [
    ["半形空白", "array[' ']"],
    ["定位字元", "array[E'\t']"],
    ["換行", "array[E'\n']"],
    ["不斷行空白", "array[E'\u00a0']"],
  ]) {
    ok(
      `只有${label}的規則寫不進去`,
      psql(`insert into public.design_knowledge (category, title, summary, rules) values ('color', '空白偽裝', '摘要', ${literal});`, { expectError: true }).failed,
    );
  }

  // (n) 高信任等級必須留下審查時間
  ok(
    "宣稱 approved 但沒有 reviewed_at 會被擋",
    as(owner, `insert into public.design_knowledge (category, title, summary, rules, project_specific, created_by, status, trust_level) values ('brand-rules', '未經審查就自稱已核准', '摘要', array['規則'], '${capRoom}'::uuid, '${owner}'::uuid, 'approved', 'approved');`).failed,
  );
  ok(
    "補上 reviewed_at 後可以寫入",
    !as(owner, `insert into public.design_knowledge (category, title, summary, rules, project_specific, created_by, status, trust_level, reviewed_at) values ('brand-rules', '審查過的規範', '摘要', array['規則'], '${capRoom}'::uuid, '${owner}'::uuid, 'approved', 'project', now());`).failed,
  );

  // (k) 冪等：重跑不炸、seed 不重複、policy 形狀不變
  const knShape = () => psql(`select
    (select count(*) from pg_policies where tablename = 'design_knowledge') || '/' ||
    (select count(*) from public.design_knowledge where project_specific is null);`).out;
  const knBefore = knShape();
  psqlFile(join(MIGRATIONS, "0029_design_knowledge.sql"));
  ok("重跑 0029 後 policy 數與 seed 筆數不變", knBefore === knShape(), `${knBefore} → ${knShape()}`);

  section("0030：外部研究使用量（append-only、後端才能寫）");
  psqlFile(join(MIGRATIONS, "0030_design_research_usage.sql"));

  // 用**真的 service_role**寫一筆（edge function 走的就是這條路）。
  //
  // 對抗審查指出這裡原本用的是無角色的 psql（也就是超級使用者），
  // 那證明不了 service_role 有沒有權限 —— 超級使用者本來就什麼都能做。
  const usageHash = "a".repeat(64);
  const asService = (sql) => psql(`set role service_role; ${sql}`, { expectError: true });
  ok(
    "service_role 寫得進使用量",
    !asService(`insert into public.design_research_usage (room_id, query_hash, source_count) values ('${capRoom}'::uuid, '${usageHash}', 3);`).failed,
  );

  ok("房內成員讀得到自己房間的用量", as(owner, `select count(*) from public.design_research_usage where room_id = '${capRoom}'::uuid;`).out === "1");

  // 寫：**沒有 client 政策**。讓 client 寫使用量＝讓 client 自己決定用了幾次。
  ok(
    "登入者寫不進使用量",
    as(owner, `insert into public.design_research_usage (room_id, query_hash) values ('${capRoom}'::uuid, '${"b".repeat(64)}');`).failed,
  );
  ok(
    "登入者改不掉已寫入的使用量",
    as(owner, `update public.design_research_usage set source_count = 0 where room_id = '${capRoom}'::uuid;`).failed,
  );
  ok(
    "登入者刪不掉使用量（append-only）",
    as(owner, `delete from public.design_research_usage where room_id = '${capRoom}'::uuid;`).failed,
  );
  ok("anon 讀不到使用量", asAnon(`select count(*) from public.design_research_usage;`).out === "0" || asAnon(`select count(*) from public.design_research_usage;`).failed);

  // 不存查詢原文：欄位只收 64 字元的雜湊
  ok(
    "查詢原文塞不進去（欄位只收 64 字元雜湊）",
    psql(`insert into public.design_research_usage (room_id, query_hash) values ('${capRoom}'::uuid, '海報的對比要多少才夠');`, { expectError: true }).failed,
  );

  // 補一條：**只有 select 被 grant 給 authenticated**。
  // 這是 0030 與 0019 的稽核表最大的差別，而檔頭原本抄錯了 0019 的說法。
  // **RLS 不管 TRUNCATE。** 任何登入者能 truncate，等於所有 policy 都白寫。
  ok(
    "登入者 truncate 不掉使用量表",
    as(owner, `truncate public.design_research_usage;`).failed,
  );
  ok(
    "登入者 truncate 不掉知識庫",
    as(owner, `truncate public.design_knowledge;`).failed,
  );
  ok(
    "authenticated 對使用量表只有 select 權限",
    psql(`select string_agg(privilege_type, ',' order by privilege_type)
          from information_schema.role_table_grants
          where table_name = 'design_research_usage' and grantee = 'authenticated';`).out === "SELECT",
    psql(`select coalesce(string_agg(privilege_type, ',' order by privilege_type), '(無)')
          from information_schema.role_table_grants
          where table_name = 'design_research_usage' and grantee = 'authenticated';`).out,
  );

  const usageShape = () => psql(`select
    (select count(*) from pg_policies where tablename = 'design_research_usage') || '/' ||
    (select count(*) from public.design_research_usage);`).out;
  const usageBefore = usageShape();
  psqlFile(join(MIGRATIONS, "0030_design_research_usage.sql"));
  ok("重跑 0030 後 policy 數與資料不變", usageBefore === usageShape(), `${usageBefore} → ${usageShape()}`);

  section("0031：討論 tombstone + 未讀水位 RLS");
  const tombOwn = psql("select gen_random_uuid();").out;
  const tombOther = psql("select gen_random_uuid();").out;
  const tombManage = psql("select gen_random_uuid();").out;
  ok(
    "作者可以發一則之後標 tombstone",
    !as(reviewer, `insert into public.room_discussion_messages (id, room_id, author_user_id, author_name, body) values ('${tombOwn}'::uuid, '${capRoom}'::uuid, '${reviewer}'::uuid, 'Reviewer', '這則之後會刪');`).failed
      && !as(reviewer, `update public.room_discussion_messages set deleted_at = now() where id = '${tombOwn}'::uuid and room_id = '${capRoom}'::uuid;`).failed
      && as(reviewer, `select deleted_at is not null from public.room_discussion_messages where id = '${tombOwn}'::uuid;`).out === "t",
  );
  ok(
    "tombstone 之後列還在（軟刪不是硬刪）",
    as(owner, `select count(*) from public.room_discussion_messages where id = '${tombOwn}'::uuid;`).out === "1",
  );
  ok(
    "作者不能硬刪自己的訊息",
    as(reviewer, `delete from public.room_discussion_messages where id = '${tombOwn}'::uuid;`).failed
      && as(owner, `select count(*) from public.room_discussion_messages where id = '${tombOwn}'::uuid;`).out === "1",
  );
  as(owner, `insert into public.room_discussion_messages (id, room_id, author_user_id, author_name, body) values ('${tombOther}'::uuid, '${capRoom}'::uuid, '${owner}'::uuid, 'Owner', '別人不能刪');`);
  as(reviewer, `update public.room_discussion_messages set deleted_at = now() where id = '${tombOther}'::uuid;`);
  ok(
    "檢視者不能 tombstone 別人的訊息",
    as(owner, `select deleted_at is null from public.room_discussion_messages where id = '${tombOther}'::uuid;`).out === "t",
  );
  as(reviewer, `insert into public.room_discussion_messages (id, room_id, author_user_id, author_name, body) values ('${tombManage}'::uuid, '${capRoom}'::uuid, '${reviewer}'::uuid, 'Reviewer', '管理者可刪');`);
  ok(
    "can_manage 可以 tombstone 成員的訊息",
    !as(owner, `update public.room_discussion_messages set deleted_at = now() where id = '${tombManage}'::uuid;`).failed
      && as(owner, `select deleted_at is not null from public.room_discussion_messages where id = '${tombManage}'::uuid;`).out === "t",
  );
  as(stranger, `update public.room_discussion_messages set deleted_at = now() where id = '${tombOther}'::uuid;`);
  ok(
    "非成員不能 tombstone 別房訊息",
    as(owner, `select deleted_at is null from public.room_discussion_messages where id = '${tombOther}'::uuid;`).out === "t",
  );
  ok(
    "tombstone 不能順便把訊息搬到別的房間",
    as(owner, `update public.room_discussion_messages set deleted_at = now(), room_id = '${otherRoom}'::uuid where id = '${tombOther}'::uuid;`).failed
      && as(owner, `select room_id from public.room_discussion_messages where id = '${tombOther}'::uuid;`).out === otherRoom
        ? false
        : as(owner, `select room_id from public.room_discussion_messages where id = '${tombOther}'::uuid;`).out === capRoom,
  );
  ok(
    "已刪的訊息不能再改 body",
    as(reviewer, `update public.room_discussion_messages set body = '洗白' where id = '${tombOwn}'::uuid;`).failed,
  );
  as(owner, `update public.room_discussion_messages set deleted_at = now(), deleted_by = '${reviewer}'::uuid where id = '${tombOther}'::uuid;`);
  ok(
    "tombstone 不能把 deleted_by 偽造成別人",
    as(owner, `select deleted_by from public.room_discussion_messages where id = '${tombOther}'::uuid;`).out === owner,
  );

  const readMsg = tombOther;
  ok(
    "成員可以寫自己的未讀水位",
    !as(owner, `insert into public.room_discussion_reads (room_id, user_id, last_read_message_id) values ('${capRoom}'::uuid, '${owner}'::uuid, '${readMsg}'::uuid);`).failed,
  );
  ok(
    "不能幫別人寫未讀水位",
    as(owner, `insert into public.room_discussion_reads (room_id, user_id, last_read_message_id) values ('${capRoom}'::uuid, '${reviewer}'::uuid, '${readMsg}'::uuid);`).failed,
  );
  ok(
    "只能讀到自己的未讀水位（不是已讀回條）",
    as(reviewer, `select count(*) from public.room_discussion_reads where room_id = '${capRoom}'::uuid;`).out === "0"
      && as(owner, `select count(*) from public.room_discussion_reads where room_id = '${capRoom}'::uuid;`).out === "1",
  );
  ok(
    "非成員讀不到也寫不了別房的未讀水位",
    as(stranger, `select count(*) from public.room_discussion_reads where room_id = '${capRoom}'::uuid;`).out === "0"
      && as(stranger, `insert into public.room_discussion_reads (room_id, user_id) values ('${capRoom}'::uuid, '${stranger}'::uuid);`).failed,
  );
  ok(
    "未讀水位不能指向別房的訊息（跨房）",
    as(owner, `insert into public.room_discussion_reads (room_id, user_id, last_read_message_id) values ('${otherRoom}'::uuid, '${owner}'::uuid, '${readMsg}'::uuid);`).failed,
  );
  ok(
    "authenticated 對未讀表沒有 DELETE",
    as(owner, `delete from public.room_discussion_reads where room_id = '${capRoom}'::uuid;`).failed
      && as(owner, `select count(*) from public.room_discussion_reads where room_id = '${capRoom}'::uuid;`).out === "1",
  );
  as(reviewer, `update public.room_discussion_reads set last_read_at = now() where room_id = '${capRoom}'::uuid and user_id = '${owner}'::uuid;`);
  ok(
    "不能改別人的未讀水位（BOLA）",
    as(reviewer, `select count(*) from public.room_discussion_reads where room_id = '${capRoom}'::uuid;`).out === "0"
      && as(owner, `select user_id from public.room_discussion_reads where room_id = '${capRoom}'::uuid;`).out === owner,
  );
  as(owner, `update public.room_discussion_reads set user_id = '${reviewer}'::uuid where room_id = '${capRoom}'::uuid;`);
  ok(
    "不能把未讀水位改掛到別人",
    as(owner, `select user_id from public.room_discussion_reads where room_id = '${capRoom}'::uuid;`).out === owner,
  );

  // 0014 在本檔稍早被重跑過，會把 room_discussion_delete 放回來。
  // 先再套一次 0031 回到穩定形狀，再重跑證明冪等。
  psqlFile(join(MIGRATIONS, "0031_discussion_tombstone_unread.sql"));
  const tombShape = () => psql(`select
    (select count(*) from pg_policies where tablename in ('room_discussion_messages','room_discussion_reads')) || '/' ||
    (select count(*) from information_schema.columns where table_name = 'room_discussion_messages' and column_name in ('deleted_at','deleted_by'));`).out;
  const tombBefore = tombShape();
  psqlFile(join(MIGRATIONS, "0031_discussion_tombstone_unread.sql"));
  ok("重跑 0031 後 policy 數與 tombstone 欄不變", tombBefore === tombShape(), `${tombBefore} → ${tombShape()}`);
  psqlFile(join(MIGRATIONS, "0014_collaboration_workspace.sql"));
  ok(
    "重跑 0014 之後仍然不能硬刪討論（0031 trigger 不被 replay 洗掉）",
    as(owner, `delete from public.room_discussion_messages where id = '${tombOwn}'::uuid;`).failed
      && as(owner, `select count(*) from public.room_discussion_messages where id = '${tombOwn}'::uuid;`).out === "1",
  );

  section("0032：討論提及 + 待辦草稿 RLS");
  const mentionMsg = psql("select gen_random_uuid();").out;
  const todoOwn = psql("select gen_random_uuid();").out;
  const todoForge = psql("select gen_random_uuid();").out;
  const todoMove = psql("select gen_random_uuid();").out;
  as(owner, `insert into public.room_discussion_messages (id, room_id, author_user_id, author_name, body) values ('${mentionMsg}'::uuid, '${capRoom}'::uuid, '${owner}'::uuid, 'Owner', '先看 @Reviewer');`);
  ok(
    "作者可以提及本房成員",
    !as(owner, `insert into public.room_discussion_mentions (message_id, room_id, mentioned_user_id) values ('${mentionMsg}'::uuid, '${capRoom}'::uuid, '${reviewer}'::uuid);`).failed
      && as(owner, `select count(*) from public.room_discussion_mentions where message_id = '${mentionMsg}'::uuid;`).out === "1",
  );
  ok(
    "不能提及非成員",
    as(owner, `insert into public.room_discussion_mentions (message_id, room_id, mentioned_user_id) values ('${mentionMsg}'::uuid, '${capRoom}'::uuid, '${stranger}'::uuid);`).failed,
  );
  ok(
    "別人不能替作者寫提及",
    as(reviewer, `insert into public.room_discussion_mentions (message_id, room_id, mentioned_user_id) values ('${mentionMsg}'::uuid, '${capRoom}'::uuid, '${owner}'::uuid);`).failed,
  );
  ok(
    "非成員讀不到別房的提及",
    as(stranger, `select count(*) from public.room_discussion_mentions where room_id = '${capRoom}'::uuid;`).out === "0",
  );
  ok(
    "提及不能掛到別的房間（跨房）",
    as(owner, `insert into public.room_discussion_mentions (message_id, room_id, mentioned_user_id) values ('${mentionMsg}'::uuid, '${otherRoom}'::uuid, '${reviewer}'::uuid);`).failed,
  );
  const otherMentionMsg = psql("select gen_random_uuid();").out;
  as(owner, `insert into public.room_discussion_messages (id, room_id, author_user_id, author_name, body) values ('${otherMentionMsg}'::uuid, '${otherRoom}'::uuid, '${owner}'::uuid, 'Owner', '另一間房');`);
  ok(
    "不能在這房提及只屬於另一房的人（跨房 BOLA）",
    as(owner, `insert into public.room_discussion_mentions (message_id, room_id, mentioned_user_id) values ('${otherMentionMsg}'::uuid, '${otherRoom}'::uuid, '${reviewer}'::uuid);`).failed
      && as(owner, `select count(*) from public.room_discussion_mentions where message_id = '${otherMentionMsg}'::uuid;`).out === "0",
  );
  as(owner, `update public.room_discussion_mentions set mentioned_user_id = '${owner}'::uuid where message_id = '${mentionMsg}'::uuid;`);
  ok(
    "提及不能改掛被提及的人",
    as(owner, `select mentioned_user_id from public.room_discussion_mentions where message_id = '${mentionMsg}'::uuid;`).out === reviewer,
  );
  ok(
    "成員可以建自己的待辦",
    !as(reviewer, `insert into public.room_todos (id, room_id, title) values ('${todoOwn}'::uuid, '${capRoom}'::uuid, '印海報');`).failed
      && as(reviewer, `select title from public.room_todos where id = '${todoOwn}'::uuid;`).out === "印海報",
  );
  ok(
    "不能冒充別人建待辦",
    as(reviewer, `insert into public.room_todos (id, room_id, title, created_by) values ('${todoForge}'::uuid, '${capRoom}'::uuid, '假的', '${owner}'::uuid);`).failed,
  );
  ok(
    "非成員不能在別房建待辦",
    as(stranger, `insert into public.room_todos (room_id, title) values ('${capRoom}'::uuid, '路人待辦');`).failed,
  );
  as(owner, `insert into public.room_todos (id, room_id, title) values ('${todoMove}'::uuid, '${capRoom}'::uuid, '不要搬房');`);
  as(owner, `update public.room_todos set room_id = '${otherRoom}'::uuid where id = '${todoMove}'::uuid;`);
  ok(
    "待辦不能搬到別的房間（跨房）",
    as(owner, `select room_id from public.room_todos where id = '${todoMove}'::uuid;`).out === capRoom,
  );
  ok(
    "作者可以把待辦標完成",
    !as(reviewer, `update public.room_todos set status = 'done' where id = '${todoOwn}'::uuid;`).failed
      && as(reviewer, `select status from public.room_todos where id = '${todoOwn}'::uuid;`).out === "done",
  );
  as(reviewer, `update public.room_todos set status = 'done' where id = '${todoMove}'::uuid;`);
  ok(
    "檢視者不能完成別人的待辦（peer BOLA）",
    as(owner, `select status from public.room_todos where id = '${todoMove}'::uuid;`).out === "open",
  );
  as(stranger, `update public.room_todos set status = 'done' where id = '${todoMove}'::uuid;`);
  ok(
    "非成員不能把別房待辦標完成",
    as(owner, `select status from public.room_todos where id = '${todoMove}'::uuid;`).out === "open",
  );
  ok(
    "authenticated 對提及與待辦沒有 DELETE",
    as(owner, `delete from public.room_discussion_mentions where message_id = '${mentionMsg}'::uuid;`).failed
      && as(owner, `delete from public.room_todos where id = '${todoMove}'::uuid;`).failed
      && as(owner, `select count(*) from public.room_discussion_mentions where message_id = '${mentionMsg}'::uuid;`).out === "1"
      && as(owner, `select count(*) from public.room_todos where id = '${todoMove}'::uuid;`).out === "1",
  );

  const mentionShape = () => psql(`select
    (select count(*) from pg_policies where tablename in ('room_discussion_mentions','room_todos')) || '/' ||
    (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('room_discussion_mentions','room_todos'));`).out;
  const mentionBefore = mentionShape();
  psqlFile(join(MIGRATIONS, "0032_discussion_mentions_todos.sql"));
  ok("重跑 0032 後 policy 數與表不變", mentionBefore === mentionShape(), `${mentionBefore} → ${mentionShape()}`);

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
