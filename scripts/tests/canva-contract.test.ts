/**
 * PR-05 canva-bridge 契約與證據測試。
 *
 * 兩層：extractCanvaDesignId 的純函式行為；以及「宣稱必須有實作」的
 * 源碼證據 — secret 邊界（token 只活在 edge＋service-role 表）、PKCE、
 * 串流計量、RLS 前置檢查。防止有人只加 UI 不接後端，或把 token 帶進
 * 瀏覽器。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANVA_ENTRY_COPY,
  CANVA_ENTRY_TESTID,
  CANVA_EXPORT_PENDING_COPY,
  canShowCanvaSync,
  canvaEntryState,
  extractCanvaDesignId,
} from "../../src/lib/canvaContract";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("extractCanvaDesignId：網址、裸 id、垃圾輸入", () => {
  assert.equal(
    extractCanvaDesignId("https://www.canva.com/design/DAGabc123_-x/edit?utm=1"),
    "DAGabc123_-x",
  );
  assert.equal(extractCanvaDesignId("  DAGabc123 "), "DAGabc123");
  assert.equal(extractCanvaDesignId("https://evil.example/design/DAGabc123"), null);
  assert.equal(extractCanvaDesignId("DAG abc"), null);
  assert.equal(extractCanvaDesignId("../../etc/passwd"), null);
  assert.equal(extractCanvaDesignId(""), null);
  assert.equal(extractCanvaDesignId("x".repeat(81)), null);
});

test("canva-bridge edge：OAuth 走 PKCE＋Basic、token 永不出橋", () => {
  const edge = readFileSync(resolve(ROOT, "supabase/functions/canva-bridge/index.ts"), "utf8");
  // PKCE：S256 challenge、verifier 存 state 表、callback 一次性消費
  assert.match(edge, /code_challenge_method/);
  assert.match(edge, /S256/);
  assert.match(edge, /canva_oauth_states/);
  // token 交換用 Basic（client secret 只在 edge env）
  assert.match(edge, /Basic \$\{btoa\(/);
  // token 落 service-role 專用表；access_token 只出現在 edge 側
  assert.match(edge, /canva_connections/);
  assert.match(edge, /SUPABASE_SERVICE_ROLE_KEY/);
  // 匯入前置角色檢查與 cutos 同線（RLS 才是權威）
  assert.match(edge, /room_role/);
  // 串流計量（CL 可缺可謊）＋上限
  assert.match(edge, /MAX_IMPORT_BYTES/);
  assert.match(edge, /reader\.cancel/);
  // 上游 fetch 不跟 redirect（除簽名下載 URL 外）
  assert.match(edge, /redirect: "manual"/);
  // SSRF host 邊界（Grok 05 F4）：光 https 前綴不夠 — host 必須是
  // apiBase 或 *.canva.com
  assert.match(edge, /downloadHost === apiHost/);
  assert.match(edge, /endsWith\(".canva.com"\)/);
  // refresh 失敗分級（Grok 05 F3）：暫時性不刪列
  assert.match(edge, /failure === "unreachable"/);
});

test("callback 的平台 JWT 閘已在 config.toml 關掉（Grok 05 F1）", () => {
  const toml = readFileSync(resolve(ROOT, "supabase/config.toml"), "utf8");
  assert.match(toml, /\[functions\.canva-bridge\][^[]*verify_jwt = false/);
});

test("0020：token 表對 client 是不存在的（RLS＋revoke 雙層）", () => {
  const migration = readFileSync(resolve(ROOT, "supabase/migrations/0020_canva_bridge.sql"), "utf8");
  assert.match(migration, /canva_connections enable row level security/);
  assert.match(migration, /canva_oauth_states enable row level security/);
  assert.match(migration, /revoke all on public\.canva_connections from anon, authenticated/);
  assert.match(migration, /revoke all on public\.canva_oauth_states from anon, authenticated/);
});

test("client 呼叫層永不經手 token / secret", () => {
  const client = readFileSync(resolve(ROOT, "src/cloud/canva.ts"), "utf8");
  assert.doesNotMatch(client, /access_token|refresh_token|client_secret|CANVA_CLIENT/);
  // 只認識動作詞彙
  for (const action of ["health", "status", "connect-url", "list-designs", "import-design"]) {
    assert.ok(client.includes(`"${action}"`), `client 缺動作 ${action}`);
  }
});

test("Canva 入口三態：沒設定仍可見，不准整座蒸發", () => {
  assert.equal(canvaEntryState({ ok: false, code: "CANVA_NOT_CONFIGURED" }, false), "not-configured");
  assert.equal(canvaEntryState({ ok: false, code: "CANVA_UNREACHABLE" }, false), "unreachable");
  assert.equal(canvaEntryState({ ok: false }, false), "unreachable");
  assert.equal(canvaEntryState({ ok: true }, false), "connect");
  assert.equal(canvaEntryState({ ok: true }, true), "picker");
  assert.equal(canvaEntryState(null, false), "loading");
  const room = readFileSync(resolve(ROOT, "src/features/multi-room/MultiBranchRoom.tsx"), "utf8");
  assert.match(room, /canva-entry-not-configured/);
  assert.match(room, /canva-entry-unreachable/);
  assert.match(room, /canva-entry-connect/);
  assert.match(room, /canva-entry-picker/);
  assert.match(room, /canva-import-option/);
  assert.match(room, /canva-connect/);
  assert.match(room, /canva-design-item/);
  assert.match(room, /CanvaCreateOption/);
  assert.match(room, /CANVA_ENTRY_COPY\["not-configured"\]/);
  assert.match(room, /CANVA_ENTRY_COPY\.unreachable/);
  assert.match(room, /CANVA_ENTRY_COPY\.connect/);
  assert.match(room, /我連好了/);
  assert.doesNotMatch(room, /這台正式站還沒設定 Canva/);
  assert.doesNotMatch(room, /暫時連不上 Canva 橋/);
  assert.equal(
    CANVA_ENTRY_COPY["not-configured"],
    "Canva 整合尚未設定。金鑰在 Supabase 函式 secrets，不在這份程式裡。",
  );
  assert.equal(CANVA_ENTRY_COPY.unreachable, "現在連不到 Canva 橋，稍後再試。");
  assert.equal(CANVA_ENTRY_COPY.connect, "還沒連結這個 Canva 帳號");
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(app, /canvaHealthState/);
  assert.match(app, /CANVA_EXPORT_PENDING_COPY/);
  assert.doesNotMatch(app, /setCanvaReady\(Boolean\(health\.ok\)\)/);
  assert.equal(CANVA_ENTRY_TESTID["not-configured"], "canva-entry-not-configured");
  assert.equal(CANVA_ENTRY_TESTID.unreachable, "canva-entry-unreachable");
  assert.equal(CANVA_ENTRY_TESTID.connect, "canva-entry-connect");
  assert.equal(CANVA_ENTRY_TESTID.picker, "canva-entry-picker");
  assert.equal(CANVA_EXPORT_PENDING_COPY, "Canva 還在轉檔，請再試一次");
});

test("同步這一版：同一 designId append，舊 id／path 不變", () => {
  assert.equal(canShowCanvaSync({ canvaDesignId: "DAGabc" }, true), true);
  assert.equal(canShowCanvaSync({ canvaDesignId: "DAGabc" }, false), false);
  assert.equal(canShowCanvaSync({}, true), false);
  const edge = readFileSync(resolve(ROOT, "supabase/functions/canva-bridge/index.ts"), "utf8");
  assert.match(edge, /crypto\.randomUUID\(\)/);
  assert.match(edge, /upsert: false/);
  assert.match(edge, /\.from\("versions"\)\.insert\(/);
  assert.doesNotMatch(edge, /\.from\("versions"\)\.update\(/);
  assert.match(edge, /canva_design_id: designId/);
  const app = readFileSync(resolve(ROOT, "src/App.tsx"), "utf8");
  assert.match(app, /syncCanvaVersion/);
  assert.match(app, /importFromCanva\(version\.canvaDesignId/);
  const mobile = readFileSync(resolve(ROOT, "src/features/image-review/MobileWorkspace.tsx"), "utf8");
  const desktop = readFileSync(resolve(ROOT, "src/features/image-review/DesktopWorkspace.tsx"), "utf8");
  for (const file of [mobile, desktop]) {
    assert.match(file, /canva-sync-version/);
    assert.match(file, /同步這一版/);
  }
  const repo = readFileSync(resolve(ROOT, "src/cloud/roomRepository.ts"), "utf8");
  assert.match(repo, /canvaDesignId: row\.canva_design_id/);
  assert.match(repo, /imagePath: row\.image_path/);
});
