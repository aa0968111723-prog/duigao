/** CUTOS S2S 契約鏡像（PR-07）。fixture 逐字對照 CUTOS repo 的 wire 形狀。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CUTOS_ERROR_CODES,
  CUTOS_PROTOCOL_VERSION,
  buildInvocation,
  checkProtocolCompatibility,
  isRetryableCutosError,
  parseCapabilityResponse,
} from "../../src/lib/cutosContract";

test("v2 envelope：requestId 必帶、idempotencyKey 選帶", () => {
  const bare = buildInvocation("get_job", { jobId: "j1" }, { requestId: "r1" });
  assert.deepEqual(bare, {
    protocolVersion: "cutos.agent.v2",
    capability: "get_job",
    args: { jobId: "j1" },
    correlation: { requestId: "r1" },
  });
  const keyed = buildInvocation("export", { projectId: "p1" }, { requestId: "r2", idempotencyKey: "k1" });
  assert.equal(keyed.correlation.idempotencyKey, "k1");
});

test("成功回應（CapabilityResult 形狀）解析", () => {
  const parsed = parseCapabilityResponse({
    protocolVersion: CUTOS_PROTOCOL_VERSION,
    capability: "export",
    ok: true,
    result: { jobId: "job_1" },
    correlation: { requestId: "r1" },
    activity: [],
    replayed: false,
  });
  assert.equal(parsed?.ok, true);
  assert.deepEqual((parsed as { result: unknown }).result, { jobId: "job_1" });
});

test("失敗回應：詞彙表內的碼原樣、表外的碼折疊成 INTERNAL", () => {
  const known = parseCapabilityResponse({
    capability: "apply_edit_plan",
    ok: false,
    error: { code: "APPROVAL_REQUIRED", message: "human approval required" },
  });
  assert.equal(known?.ok, false);
  assert.equal((known as { error: { code: string } }).error.code, "APPROVAL_REQUIRED");
  const unknown = parseCapabilityResponse({
    capability: "x",
    ok: false,
    error: { code: "SOMETHING_NEW", message: "??" },
  });
  assert.equal((unknown as { error: { code: string } }).error.code, "INTERNAL");
});

test("垃圾輸入回 null，不丟例外", () => {
  assert.equal(parseCapabilityResponse(null), null);
  assert.equal(parseCapabilityResponse("ok"), null);
  assert.equal(parseCapabilityResponse({ ok: true }), null); // 缺 capability
});

test("協商：偏好 v2；只會 v1 就談 v1；對不上大聲失敗", () => {
  assert.deepEqual(checkProtocolCompatibility("cutos.agent.v2", ["cutos.agent.v1"]), {
    compatible: true,
    negotiated: "cutos.agent.v2",
  });
  assert.deepEqual(checkProtocolCompatibility("cutos.agent.v1", []), {
    compatible: true,
    negotiated: "cutos.agent.v1",
  });
  assert.deepEqual(checkProtocolCompatibility("cutos.agent.v9", ["cutos.agent.v8"]), {
    compatible: false,
    code: "PROTOCOL_VERSION_MISMATCH",
  });
  assert.deepEqual(checkProtocolCompatibility(undefined, undefined), {
    compatible: false,
    code: "PROTOCOL_VERSION_UNKNOWN",
  });
});

test("錯誤碼詞彙 20 個成員；可重試子集正確", () => {
  assert.equal(CUTOS_ERROR_CODES.length, 20);
  assert.equal(isRetryableCutosError("TIMEOUT"), true);
  assert.equal(isRetryableCutosError("UNAVAILABLE"), true);
  assert.equal(isRetryableCutosError("APPROVAL_REQUIRED"), false);
  assert.equal(isRetryableCutosError(undefined), false);
});
