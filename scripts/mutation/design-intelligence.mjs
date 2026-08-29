#!/usr/bin/env node
/**
 * Design Intelligence 的變異測試器。
 *
 * **為什麼要提交進 repo**：評估報告原本寫「跨六個階段共 50 個變異體，
 * 全數被殺死」，但沒有清單、沒有可重跑的指令 —— 那個數字讀者無法查證，
 * 而「無法查證的數字」正是這個分支一路在反對的東西。對抗審查點名了這一點。
 * 現在它是一支可以跑的腳本，數字由 `npm run mutation:design-intelligence`
 * 產生。
 *
 * 做什麼：把實作改壞（每次一處），跑測試，確認測試**會紅**。
 * 一個活下來的變異體代表那條紅線沒有被任何測試守住。
 *
 * **中斷安全**：每個變異體套用前後都從快照還原，並用 try/finally 保證。
 * 舊版把還原放在收尾，腳本逾時被殺就留下變異體毒化工作區 ——
 * 實際踩過一次，害我追了一個不存在的 bug。
 *
 * 用法：
 *   npm run mutation:design-intelligence            # 全部
 *   npm run mutation:design-intelligence -- --batch 2   # 只跑第 2 批
 *   npm run mutation:design-intelligence -- --list      # 只列清單
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DIR = "src/features/design-intelligence";

const F = {
  schema: `${DIR}/schema.ts`,
  analyzers: `${DIR}/analyzers.ts`,
  analysis: `${DIR}/analysis.ts`,
  retrieval: `${DIR}/retrieval.ts`,
  lifecycle: `${DIR}/lifecycle.ts`,
  sanitize: `${DIR}/sanitize.ts`,
  research: `${DIR}/research.ts`,
  proposalView: `${DIR}/proposalView.ts`,
  adapters: `${DIR}/adapters.ts`,
};

const TESTS = [
  "schema",
  "retrieval",
  "analyzers",
  "analysis",
  "sanitize",
  "adversarial",
  "research",
  "proposal-view",
  "adapters",
  "eval",
]
  .map((name) => `scripts/tests/design-intelligence-${name}.test.ts`)
  .join(" ");

/**
 * 每個變異體：[檔案, 名稱, 原文, 替換]。
 *
 * 名稱是「把實作改成什麼」，讀起來就是那條紅線的反面。
 */
const MUTANTS = [
  // ---- 知識庫與驗證 ----
  [F.schema, "採信模型自稱的 measured", "      measured: false,", "      measured: record.measured === true,"],
  [F.schema, "不替模型的診斷 id 加命名空間", "      id: `ai-${text(record.id, 48) ?? value.length + 1}`,", "      id: text(record.id, 64) ?? `dx-${value.length + 1}`,"],
  [F.schema, "衝突偵測：不比對運算子相容性（把「至少 24」與「至少 44」當成矛盾）", "    if (!incompatible(list.map((item) => item.constraint))) continue;", ""],
  [F.schema, "SSRF：不擋迴環別名網域", "  if (LOOPBACK_ALIAS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;", ""],
  [F.schema, "SSRF：不擋任何形式的 IP（字面值、IPv6、嵌在主機名裡的）", "  if (hostContainsIp(host)) return false;", ""],
  [F.schema, "衝突偵測：一條規則只取第一個數值", "  if (out.length) return out;", "  return out;"],

  // ---- 檢索 ----
  [F.retrieval, "房界：空字串當成通用知識", 'if (owner === "invalid") {', "if (false) {"],
  [F.retrieval, "專案豁免不看信任等級", 'if (normalizeProjectId(entry.projectSpecific) !== null && entry.trustLevel === "project") {', "if (entry.projectSpecific) {"],

  // ---- 本地分析器 ----
  [F.analyzers, "大字門檻回到用 isHeading 當粗體", "const isBold = fontWeight >= 700;", "const isBold = true;"],
  [F.analyzers, "找不到色票就沉默跳過", "      // 指定了色彩角色卻找不到對應色票 —— 沉默跳過會讓人以為「檢查過沒問題」。", "      continue;"],
  [F.analyzers, "觸控門檻改成 8px（形同關閉）", "  const MIN = 24;", "  const MIN = 8;"],
  [F.analyzers, "標題也套用行長行高檢查", "    if (block.isHeading) continue;", ""],
  [F.analyzers, "行動字級不分視窗寬度一律檢查", "  if (width > 480) return [];", ""],
  [F.analyzers, "對比修正不驗證是否達標", "  const darker = search({ r: 0, g: 0, b: 0 });", "  return hex;\n  const darker = search({ r: 0, g: 0, b: 0 });"],

  // ---- 分析流程 ----
  [F.analysis, "provider 掛掉時把本地診斷一起丟掉", "  const diagnostics = [...localDiagnostics, ...modelDiagnostics];", "  const diagnostics = usedProvider && modelDiagnostics.length ? modelDiagnostics : [];"],
  [F.analysis, "多樣性不比實際內容", "if (contents.length > 1 && new Set(contents).size < contents.length) {", "if (false) {"],
  [F.analysis, "強度只比相鄰兩級", "for (let j = i + 1; j < rank.length; j += 1) {", "for (let j = i + 1; j < Math.min(i + 2, rank.length); j += 1) {"],
  [F.analysis, "多樣性失敗仍給推薦", "recommendedAlternativeId: diversityFailed ? null : (alternatives[0]?.id ?? null),", "recommendedAlternativeId: alternatives[0]?.id ?? null,"],
  [F.analysis, "usedProvider 永遠是 null", "        usedProvider = selection.provider.id;", ""],
  [F.analysis, "selectProvider 不理取消", "const selection = await raceWithAbort(selectProvider(deps.providers ?? [], needs), signal);", "const selection = await selectProvider(deps.providers ?? [], needs);"],
  [F.analysis, "取消訊號不傳給 provider", "          signal,\n        });", "        });"],
  [F.analysis, "保守方案改用 confidence 過濾", "    .filter((diagnostic) => diagnostic.measured)", "    .filter((diagnostic) => diagnostic.confidence >= 0.8)"],
  [F.analysis, "沒東西可說時仍回 ready", '  const status: DesignProposal["status"] = hasSomethingToSay ? "ready" : "needs-context";', '  const status: DesignProposal["status"] = "ready";'],
  [F.analysis, "AI 沒跑成仍宣稱高信心", "  const confidence = !hasSomethingToSay ? 0 : modelRan ? 0.85 : 0.6;", "  const confidence = !hasSomethingToSay ? 0 : 0.95;"],
  [F.analysis, "知識衝突不回報", "  if (retrieval.conflicts.length) {", "  if (false) {"],
  [F.analysis, "沒有 provider 時硬湊三個方案", "      alternatives = [conservative];", '      alternatives = [conservative, { ...conservative, id: "x", strategy: "balanced" }, { ...conservative, id: "y", strategy: "bold" }];'],

  // ---- 生命週期 ----
  [F.lifecycle, "沒人核准也能套用", "if (!proposal.approvedBy || !proposal.approvedAt) {", "if (false) {"],
  [F.lifecycle, "不檢查 patch 可逆性", "if (!proposal.patch.reversible) {", "if (false) {"],
  [F.lifecycle, "不檢查轉移合法性", "if (!canTransition(proposal.status, next)) {", "if (false) {"],
  [F.lifecycle, "核准不必記錄是誰", "    if (!context.actor) {", "    if (false) {"],
  [F.lifecycle, "套用前不記錄基準版本", "    if (!context.baseRevision) {", "    if (false) {"],

  // ---- 出入站安全 ----
  [F.sanitize, "出站掃描只警告不阻擋", "  if (!scan.safe) {", "  if (false) {"],
  [F.sanitize, "不移除零寬與雙向覆寫字元", '.replace(/[\\u200b-\\u200f\\u2060-\\u2064\\ufeff\\u202a-\\u202e]/g, "")', ""],
  [F.sanitize, "不標記 prompt injection", "    if (pattern.test(input)) suspicious.push(name);", ""],
  [F.sanitize, "topics 不掃描", '  const parts = [input.question, ...(input.topics ?? [])].join(" ");', "  const parts = input.question;"],
  [F.sanitize, "外部內容可以是 approved", 'return content.suspicious.length > 0 ? "unverified" : "machine";', 'return "machine";'],

  // ---- 研究層 ----
  [F.research, "快取鍵不含房間 id", "  return `${roomId}|${query}`;", "  return query;"],
  [F.research, "共用請求吃第一個呼叫端的 signal", "        response = await options.transport({ roomId: options.roomId, query, timeoutMs: filters?.timeoutMs });", "        response = await options.transport({ roomId: options.roomId, query, timeoutMs: filters?.timeoutMs }, filters?.signal);"],
  [F.research, "上游限流被當成自己的配額用完", '        const upstream = response.body.error === "UPSTREAM_RATE_LIMITED";', "        const upstream = false;"],
  [F.research, "沒設定也累積成斷路器失敗", "      if (response.status === 503) {", "      if (false) {"],
  [F.research, "被擋下時把原始問題帶回去", '      return withMeta(emptyResult("（已停止送出：內容含不應外流的資訊）", now, {}), {', "      return withMeta(emptyResult(question, now, {}), {"],
  [F.research, "fetchRelevantSnippets 假裝抓過", "      return [];", '      return [{ id: "x", url: urls[0] ?? "", title: null, publisher: null, publishedAt: null, retrievedAt: 0, sourceType: "unknown", excerpt: "假的" }] as never;'],

  // ---- 提案呈現 ----
  [F.proposalView, "沒有權限也放行", '  if (!canApply) return { enabled: false, reason: "你在這個房間沒有修改作品的權限" };', ""],
  [F.proposalView, "斜向手勢也算換頁（比例放寬到 1.4）", "  if (absX < absY * 2) return null;", "  if (absX < absY * 1.4) return null;"],
  [F.proposalView, "滑到頭會繞回", "  return Math.max(0, Math.min(count - 1, target));", "  return ((target % count) + count) % count;"],
  [F.proposalView, "極矮視窗不限制 peek", "    const peekPx = Math.max(32, Math.min(56, Math.round(viewport.height * 0.12)));", "    const peekPx = 56;"],
  [F.proposalView, "已處理的提案仍說「沒有找到問題」", "  const processed = PROCESSED[proposal.status];", "  const processed = undefined as string | undefined;"],
  [F.proposalView, "量出來的診斷不排前面", "    if (a.measured !== b.measured) return a.measured ? -1 : 1;", ""],

  // ---- adapter ----
  [F.adapters, "Canva 未連線也回 ready", '        return { state: "unconfigured", missing: ["Canva 授權"] };', '        return { state: "ready" };'],
  [F.adapters, "網站不驗 CSS 變數名稱", "      if (!CSS_VAR_RE.test(token.cssToken)) {", "      if (false) {"],
  [F.adapters, "網站的色值改用寬鬆字元類", "      if (!CSS_HEX_RE.test(token.hex)) {", "      if (!/^[#a-z0-9 ,.()%/-]+$/i.test(token.hex)) {"],
  [F.adapters, "CUTOS 編造鏡頭秒數", "      durationSec: null as number | null,", "      durationSec: (index + 1) * 3 as number | null,"],
  [F.adapters, "白板改用新的動作型別", '      action: "add_whiteboard_node" as const,', '      action: "design_apply" as unknown as "add_whiteboard_node",'],
  [F.adapters, "檔案脈絡變成可寫", '    return { ok: false, reason: "檔案脈絡是唯讀的，不能被套用" };', '    return { ok: true, patch: { adapter: "none", payload: {}, reversible: true, revertHint: "" }, warnings: [] };'],
  [F.adapters, "終點狀態的提案仍可產生 patch", "  if (!reachable) {", "  if (false) {"],
  [F.adapters, "沒有改動的方案也接受", '  if (!alternative.changes.length) return { ok: false, reason: "這個方案沒有任何具體改動" };\n', ""],
];

const args = process.argv.slice(2);
if (args.includes("--list")) {
  MUTANTS.forEach(([file, name], index) => {
    console.log(`${String(index).padStart(2, "0")}  ${file.replace(`${DIR}/`, "")}  ${name}`);
  });
  console.log(`\n共 ${MUTANTS.length} 個變異體`);
  process.exit(0);
}

const BATCH_SIZE = 6;
const batchArg = args.indexOf("--batch");
const batches =
  batchArg >= 0
    ? [Number(args[batchArg + 1])]
    : Array.from({ length: Math.ceil(MUTANTS.length / BATCH_SIZE) }, (_, index) => index);

const files = [...new Set(MUTANTS.map(([file]) => file))];

// ---------------------------------------------------------------------------
// 護欄：工作區有未提交的變更就拒絕跑。
//
// 這支腳本會把檔案改壞再從快照還原。快照是在**啟動當下**取的，所以如果有人
// （或另一個視窗裡的我）在它跑的時候編輯同一批檔案，那些編輯會被還原覆蓋掉
// —— 而且沒有任何錯誤訊息，看起來就像編輯從來沒發生過。
//
// 這件事真的發生了：一次 `research.ts` 的修正在變異測試跑完之後憑空消失，
// 花了時間才發現不是自己記錯。git 是唯一能救回來的東西，所以要求先提交。
//
// 用 --force 可以略過，但那代表你接受未提交的變更可能被抹掉。
// ---------------------------------------------------------------------------
if (!args.includes("--force")) {
  const dirty = execSync(`git status --porcelain -- ${files.join(" ")}`, { cwd: ROOT })
    .toString()
    .trim();
  if (dirty) {
    console.error("這些檔案有未提交的變更，變異測試會用啟動時的快照覆蓋它們：\n");
    console.error(dirty);
    console.error("\n先 commit（或 stash），再跑一次。真的要冒險就加 --force。");
    process.exit(2);
  }
}

const snapshot = Object.fromEntries(files.map((file) => [file, readFileSync(join(ROOT, file), "utf8")]));
const restoreAll = () => {
  for (const [file, content] of Object.entries(snapshot)) writeFileSync(join(ROOT, file), content);
};

const survived = [];
let killed = 0;
let attempted = 0;

try {
  for (const batch of batches) {
    const slice = MUTANTS.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);
    if (!slice.length) continue;
    for (const [file, name, from, to] of slice) {
      restoreAll();
      attempted += 1;
      const src = readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
      if (!src.includes(from)) {
        console.log(`⚠ 無法套用  ${name}`);
        survived.push(`${name}（樣式沒對上 —— 實作改過了，變異體要跟著更新）`);
        continue;
      }
      writeFileSync(join(ROOT, file), src.replace(from, to));
      let red = false;
      try {
        execSync(`npx tsx --test ${TESTS}`, { cwd: ROOT, stdio: "pipe", timeout: 180_000 });
      } catch {
        red = true;
      }
      restoreAll(); // 立刻還原，不等迴圈結束
      console.log(`${red ? "✓ 被殺死" : "✗ 存活  "}  ${name}`);
      if (red) killed += 1;
      else survived.push(name);
    }
  }
} finally {
  restoreAll();
  const clean = Object.entries(snapshot).every(
    ([file, content]) => readFileSync(join(ROOT, file), "utf8") === content,
  );
  console.log(`\n還原檢查：${clean ? "乾淨" : "!! 有殘留，立刻檢查 git diff"}`);
  console.log(`${killed}/${attempted} 個變異體被殺死`);
  if (survived.length) {
    console.log(`\n存活（每一個都代表一條沒有被守住的紅線）：`);
    for (const name of survived) console.log(`  - ${name}`);
  }
  process.exitCode = survived.length ? 1 : 0;
}
