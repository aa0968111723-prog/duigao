/**
 * Edge function 的 CORS 預檢契約 — 用「真的發一個 OPTIONS」來驗，不是 grep。
 *
 * 為什麼要有這一支：supabase-js 的每一次 functions.invoke 都會帶
 * `x-client-info`（以及 `apikey`），瀏覽器因此會先送一個帶
 * `access-control-request-headers: x-client-info,...` 的預檢。允許清單漏掉
 * 它時，請求在預檢就被瀏覽器擋下 —— 但 curl／node 的 fetch 不做預檢，所以
 * 伺服器端健檢會一路是綠的。2026-08-28 正式站就是這樣：voice-token /
 * canva-bridge / cutos-bridge 全被擋，UI 只顯示「還在準備」，而所有既有
 * 測試與 curl 探針都通過。
 *
 * multi-branch 的 e2e 抓不到這個洞：mock server 在路由到函式之前就自己
 * 回應了 OPTIONS。所以這裡直接把真實 handler 載進來對它發預檢。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEdgeHandler } from "../e2e/edge-function.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FUNCTIONS_DIR = join(ROOT, "supabase", "functions");

/** supabase-js 實際會送的那一組（瀏覽器預檢問的就是這串）。 */
const BROWSER_REQUESTED = "authorization, x-client-info, apikey, content-type";

/** 每支函式都用假 env 載入即可 —— 預檢在任何 env 下都必須成立。 */
const ENV = {
  SUPABASE_URL: "https://cors-test.invalid",
  SUPABASE_ANON_KEY: "sb_publishable_cors_test_key_000000",
  SUPABASE_SERVICE_ROLE_KEY: "cors-test-service-role",
};

const functionNames = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => entry.name)
  // share-preview 只服務 GET/HEAD 的爬蟲與真人，不經 supabase-js。
  .filter((name) => name !== "share-preview");

assert.ok(functionNames.length >= 3, `找不到 edge functions：${functionNames.join(",")}`);

for (const name of functionNames) {
  test(`${name}：OPTIONS 預檢放行 supabase-js 送的標頭`, async () => {
    const handler = await loadEdgeHandler(name, ENV);
    const response = await handler(
      new Request(`https://cors-test.invalid/functions/v1/${name}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://duigao-k7q2.zeabur.app",
          "access-control-request-method": "POST",
          "access-control-request-headers": BROWSER_REQUESTED,
        },
      }),
    );

    assert.ok(response.status === 204 || response.status === 200, `預檢狀態碼 ${response.status}`);

    const allowOrigin = response.headers.get("access-control-allow-origin") ?? "";
    assert.ok(allowOrigin === "*" || allowOrigin === "https://duigao-k7q2.zeabur.app", `allow-origin=${allowOrigin}`);

    // 瀏覽器逐一比對它問的每一個標頭；少一個就整個請求被擋。
    const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    assert.ok(allowed.length > 0, "預檢沒有回 access-control-allow-headers");
    for (const header of BROWSER_REQUESTED.split(",").map((item) => item.trim())) {
      assert.ok(
        allowed === "*" || allowed.includes(header),
        `${name} 的預檢不放行 ${header}（allow-headers=${allowed}）`,
      );
    }

    const allowMethods = (response.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    assert.ok(allowMethods.includes("POST"), `allow-methods=${allowMethods}`);
  });
}
