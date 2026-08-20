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
import { mkdtempSync, rmSync, existsSync, readdirSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const SHIM = join(dirname(fileURLToPath(import.meta.url)), "supabase-shim.sql");
const PORT = 55432;

const PG_BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin", "/usr/local/pgsql/bin"].find((d) =>
  existsSync(join(d, "initdb")),
);
if (!PG_BIN) {
  console.log("略過：找不到 PostgreSQL 執行檔（initdb / pg_ctl）。");
  process.exit(0);
}

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
const PG_USER = asUser?.name ?? process.env.USER ?? "postgres";
const spawnOpts = asUser ? { uid: asUser.uid, gid: asUser.gid } : {};
const env = { ...process.env, PGHOST: sock, PGPORT: String(PORT), PGDATABASE: "duigao", PGUSER: PG_USER, HOME: sock };

function psql(sql, { expectError = false } = {}) {
  const res = spawnSync(join(PG_BIN, "psql"), ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t", "-c", sql], {
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
  const res = spawnSync(join(PG_BIN, "psql"), ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-f", file], {
    env,
    encoding: "utf8",
    ...spawnOpts,
  });
  if (res.status !== 0) throw new Error(`applying ${file} failed:\n${res.stderr}`);
  return res.stdout;
}

let started = false;
try {
  execFileSync(join(PG_BIN, "initdb"), ["-D", dataDir, "-U", PG_USER, "--auth=trust", "-E", "UTF8"], {
    stdio: "pipe",
    env,
    ...spawnOpts,
  });
  execFileSync(
    join(PG_BIN, "pg_ctl"),
    ["-D", dataDir, "-o", `-p ${PORT} -k ${sock} -c listen_addresses=''`, "-w", "-l", join(dataDir, "log"), "start"],
    { stdio: "pipe", env, ...spawnOpts },
  );
  started = true;
  execFileSync(join(PG_BIN, "createdb"), ["duigao"], { env, stdio: "pipe", ...spawnOpts });

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

  console.log(`\n${checks - failures}/${checks} 通過`);
} finally {
  if (started) {
    try {
      execFileSync(join(PG_BIN, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "pipe", env, ...spawnOpts });
    } catch {
      /* already gone */
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sock, { recursive: true, force: true });
}

if (failures) process.exit(1);
