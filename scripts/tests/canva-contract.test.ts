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
import { extractCanvaDesignId } from "../../src/lib/canvaContract";

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
