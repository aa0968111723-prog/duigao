/**
 * 本地分析器的測試（PR-DI-02）。
 *
 * 這一組刻意不斷言「有回傳診斷」。每一條都驗**使用者感受得到的事實**：
 * 建議的色碼是不是真的達標、量測數字有沒有出現在建議裡、算不出來的時候
 * 有沒有誠實說算不出來。
 *
 * 前一輪的教訓：斷言「存在」（長度 > 0、欄位不是 undefined）會讓實作被掏空
 * 之後測試仍然全綠。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  adjustToContrast,
  analyzeContrast,
  analyzeMobileLegibility,
  analyzeTapTargets,
  analyzeTypography,
  runLocalAnalyzers,
  type DesignFacts,
} from "../../src/features/design-intelligence/analyzers";
import { contrastRatio } from "../../src/features/design-intelligence/schema";
import type { ColorToken } from "../../src/features/design-intelligence/types";

function color(role: ColorToken["role"], hex: string): ColorToken {
  return {
    role,
    hex,
    rgb: { r: 0, g: 0, b: 0 },
    cssToken: `--di-${role}`,
    contrastRatio: null,
    wcag: "none",
  };
}

function facts(over: Partial<DesignFacts> = {}): DesignFacts {
  return { colors: [], textBlocks: [], tapTargets: [], ...over };
}

// ---------------------------------------------------------------------------
// adjustToContrast：建議的色碼必須真的達標
// ---------------------------------------------------------------------------

test("建議的色碼真的達到目標對比（不是估的）", () => {
  // 這五組的原始對比都**不**達標（2.05 – 2.82），所以都必須被改動。
  const cases: Array<[string, string, number]> = [
    ["#aaaaaa", "#ffffff", 4.5],   // 2.32 淺灰在白底 → 必須變暗
    ["#555555", "#000000", 4.5],   // 2.82 深灰在黑底 → 必須變亮
    ["#8f8fe8", "#ffffff", 4.5],   // 2.55 淡紫在白底
    ["#ff9f1c", "#ffffff", 3],     // 2.05 橘色，大字門檻
    ["#3d4a7a", "#0b1020", 4.5],   // 2.06 暗藍在深底 → 必須變亮
  ];
  for (const [hex, against, target] of cases) {
    const before = contrastRatio(hex, against);
    assert.ok(before !== null && before < target, `測試資料選錯了：${hex} 本來就達標`);

    const fixed = adjustToContrast(hex, against, target);
    assert.ok(fixed, `${hex} on ${against} 應該找得到達標的色碼`);
    const ratio = contrastRatio(fixed, against);
    assert.ok(
      ratio !== null && ratio >= target,
      `${hex} → ${fixed} on ${against} 只有 ${ratio}，沒有達到 ${target}`,
    );
    assert.notEqual(fixed, hex, "原本不達標卻原樣回傳，等於宣稱修好了但沒改");
    // 最小可行修正：不該一路推到純黑或純白
    assert.ok(
      fixed !== "#000000" && fixed !== "#ffffff",
      `${hex} 被推到極端值 ${fixed}，那不是最小可行的修正`,
    );
  }
});

test("本來就達標的顏色原樣回傳，不做多餘的改動", () => {
  // 使用者說「對比不夠」時，已經合格的顏色不該被動 —— 無謂的改動會讓人
  // 以為系統誤判，也會破壞既有的品牌色。
  assert.equal(adjustToContrast("#6157ef", "#ffffff", 4.5), "#6157ef");
  assert.equal(adjustToContrast("#00a3ff", "#0b1020", 4.5), "#00a3ff");
});

test("兩邊都達不到時回 null，而不是回一個沒達標的色碼", () => {
  // 中灰底：往黑往白都達不到 7:1
  const impossible = adjustToContrast("#808080", "#808080", 7);
  if (impossible !== null) {
    const ratio = contrastRatio(impossible, "#808080");
    assert.ok(ratio !== null && ratio >= 7, "回了色碼就必須真的達標");
  }
  // 不合法的輸入不得硬給答案
  assert.equal(adjustToContrast("not-a-color", "#ffffff", 4.5), null);
  assert.equal(adjustToContrast("#ffffff", "zzz", 4.5), null);
});

// ---------------------------------------------------------------------------
// 對比診斷
// ---------------------------------------------------------------------------

test("對比不足的診斷帶著量測值與一個真的達標的色碼", () => {
  const result = analyzeContrast(
    facts({
      colors: [color("surface", "#ffffff"), color("text-primary", "#aaaaaa")],
      textBlocks: [
        { id: "body", label: "活動說明內文", fontSizePx: 16, lineHeight: 1.6, charsPerLine: 60, isHeading: false },
      ],
    }),
  );
  assert.equal(result.length, 1);
  const diagnostic = result[0];

  // 問題敘述要有數字 —— 「配色可以更好」這種答案是任務書明文禁止的
  assert.match(diagnostic.issue, /2\.3\d:1/, `issue 沒有量測值：${diagnostic.issue}`);
  assert.match(diagnostic.evidence, /#aaaaaa/);
  assert.match(diagnostic.evidence, /#ffffff/);
  assert.match(diagnostic.location, /活動說明內文/, "要指出問題在哪個元素");

  // 建議裡的色碼必須真的達標 —— 這是這組測試的重點
  const suggested = diagnostic.recommendation.match(/#[0-9a-f]{6}/gi) ?? [];
  const target = suggested.find((hex) => hex.toLowerCase() !== "#aaaaaa" && hex.toLowerCase() !== "#ffffff");
  assert.ok(target, `建議裡沒有給新色碼：${diagnostic.recommendation}`);
  const ratio = contrastRatio(target, "#ffffff");
  assert.ok(ratio !== null && ratio >= 4.5, `建議的 ${target} 只有 ${ratio}:1，並沒有解決問題`);

  assert.equal(diagnostic.confidence, 1, "算出來的事實信心值就是 1");
});

test("對比達標時不製造假問題", () => {
  const result = analyzeContrast(
    facts({
      colors: [color("surface", "#ffffff"), color("text-primary", "#1a1a1a")],
      textBlocks: [
        { id: "body", label: "內文", fontSizePx: 16, lineHeight: 1.6, charsPerLine: 60, isHeading: false },
      ],
    }),
  );
  assert.equal(result.length, 0, "已經達標的配色不該被報成問題");
});

test("大字用 3:1 的門檻，不是一律 4.5:1", () => {
  const grey = color("text-primary", "#949494"); // 在白底上約 3.1:1
  const asHeading = analyzeContrast(
    facts({
      colors: [color("surface", "#ffffff"), grey],
      textBlocks: [
        { id: "h", label: "主標", fontSizePx: 32, lineHeight: 1.2, charsPerLine: 20, isHeading: true },
      ],
    }),
  );
  const asBody = analyzeContrast(
    facts({
      colors: [color("surface", "#ffffff"), grey],
      textBlocks: [
        { id: "b", label: "內文", fontSizePx: 14, lineHeight: 1.6, charsPerLine: 60, isHeading: false },
      ],
    }),
  );
  assert.equal(asHeading.length, 0, "32px 的大字用 3:1 門檻，這個灰過得了");
  assert.equal(asBody.length, 1, "同一個灰用在 14px 內文就過不了 4.5:1");
});

test("沒有背景色時說「算不出來」，不假裝算過", () => {
  const result = analyzeContrast(
    facts({
      colors: [color("text-primary", "#aaaaaa")],
      textBlocks: [
        { id: "body", label: "內文", fontSizePx: 16, lineHeight: 1.6, charsPerLine: 60, isHeading: false },
      ],
    }),
  );
  assert.equal(result.length, 1);
  assert.match(result[0].issue, /無法計算/, "缺資訊時要說缺資訊");
  assert.doesNotMatch(result[0].issue, /:1/, "沒有底色卻報出一個對比值就是編造");
});

// ---------------------------------------------------------------------------
// 觸控目標
// ---------------------------------------------------------------------------

test("觸控目標小於 24×24 才報，而且指名是哪一個", () => {
  const result = analyzeTapTargets(
    facts({
      tapTargets: [
        { id: "ok", label: "報名按鈕", widthPx: 120, heightPx: 44 },
        { id: "small", label: "關閉圖示", widthPx: 16, heightPx: 16 },
        { id: "thin", label: "分頁指示點", widthPx: 40, heightPx: 12 },
      ],
    }),
  );
  assert.equal(result.length, 2, "合格的按鈕不該被報");
  assert.deepEqual(
    result.map((diagnostic) => diagnostic.location).sort(),
    ["分頁指示點", "關閉圖示"],
  );
  // 短邊 12 的那個要比短邊 16 的嚴重
  const thin = result.find((diagnostic) => diagnostic.location === "分頁指示點");
  assert.equal(thin?.severity, "major");
  assert.match(thin?.evidence ?? "", /40×12/, "證據要有實際量測值");
});

// ---------------------------------------------------------------------------
// 排版
// ---------------------------------------------------------------------------

test("行長與行高各自獨立判斷，標題不受行長限制", () => {
  const result = analyzeTypography(
    facts({
      textBlocks: [
        { id: "long", label: "長段落", fontSizePx: 16, lineHeight: 1.6, charsPerLine: 110, isHeading: false },
        { id: "tight", label: "緊段落", fontSizePx: 16, lineHeight: 1.1, charsPerLine: 60, isHeading: false },
        { id: "head", label: "主標題", fontSizePx: 40, lineHeight: 1.1, charsPerLine: 90, isHeading: true },
      ],
    }),
  );
  const locations = result.map((diagnostic) => diagnostic.location).sort();
  assert.deepEqual(locations, ["緊段落", "長段落"], "標題不該因為行長或行高被報");

  const tight = result.find((diagnostic) => diagnostic.location === "緊段落");
  assert.match(tight?.recommendation ?? "", /1\.5/, "要給具體目標值");
  assert.match(tight?.recommendation ?? "", /24px/, "16px × 1.5 = 24px，要換算給人看");
});

// ---------------------------------------------------------------------------
// 行動裝置
// ---------------------------------------------------------------------------

test("小字只在手機尺寸下被報，桌機尺寸不報", () => {
  const small = {
    id: "tiny",
    label: "備註",
    fontSizePx: 11,
    lineHeight: 1.6,
    charsPerLine: 40,
    isHeading: false,
  };
  const onPhone = analyzeMobileLegibility(facts({ textBlocks: [small], viewportWidthPx: 360 }));
  const onDesktop = analyzeMobileLegibility(facts({ textBlocks: [small], viewportWidthPx: 1440 }));
  assert.equal(onPhone.length, 1);
  assert.equal(onDesktop.length, 0, "桌機寬度不該套用行動裝置的字級門檻");
  assert.match(onPhone[0].evidence, /360px/, "要說明是在哪個尺寸下量的");
  assert.match(onPhone[0].recommendation, /16px/);
});

// ---------------------------------------------------------------------------
// 整體
// ---------------------------------------------------------------------------

test("完全沒有 AI provider 也能產出有數字的診斷", () => {
  // 這條對應任務書第十九節：沒有金鑰時功能必須仍然可用。
  const result = runLocalAnalyzers(
    facts({
      colors: [color("surface", "#ffffff"), color("text-primary", "#bbbbbb")],
      textBlocks: [
        { id: "body", label: "內文", fontSizePx: 12, lineHeight: 1.2, charsPerLine: 95, isHeading: false },
      ],
      tapTargets: [{ id: "x", label: "關閉", widthPx: 18, heightPx: 18 }],
      viewportWidthPx: 390,
    }),
  );
  assert.ok(result.length >= 4, `本地分析應該同時抓到多類問題，實得 ${result.length}`);

  // 每一條都必須具備任務書要求的欄位，而且不能是空話
  for (const diagnostic of result) {
    assert.ok(diagnostic.location.length > 0, "要說在哪裡");
    assert.ok(diagnostic.impact.length > 0, "要說影響誰");
    assert.match(diagnostic.evidence, /\d/, `證據沒有任何數字：${diagnostic.evidence}`);
    assert.match(diagnostic.recommendation, /\d/, `建議沒有具體數值：${diagnostic.recommendation}`);
    // 任務書第十三節點名禁止的空答案
    assert.doesNotMatch(diagnostic.recommendation, /^可以(調整|優化|改善)/);
  }
});

test("完全合格的作品不會被硬挑毛病", () => {
  const result = runLocalAnalyzers(
    facts({
      colors: [color("surface", "#ffffff"), color("text-primary", "#1a1a1a")],
      textBlocks: [
        { id: "body", label: "內文", fontSizePx: 16, lineHeight: 1.6, charsPerLine: 62, isHeading: false },
      ],
      tapTargets: [{ id: "cta", label: "報名", widthPx: 160, heightPx: 48 }],
      viewportWidthPx: 390,
    }),
  );
  assert.equal(result.length, 0, "為了看起來有在工作而製造問題，比不分析更糟");
});

// ===========================================================================
// 對抗審查（grok，PR-DI-02）後補的反例
// ===========================================================================

test("WCAG 大字看的是字重，不是「這是不是標題」", () => {
  // 19px 的非粗體標題不是大字（14pt 粗體才是），要 4.5:1。
  // 舊版拿 isHeading 當粗體的代理，這個灰就被放行了。
  const grey = color("text-primary", "#949494"); // 白底約 3.03:1
  const base = { id: "h", label: "主標", lineHeight: 1.2, charsPerLine: 20, isHeading: true };

  const thin19 = analyzeContrast(
    facts({ colors: [color("surface", "#ffffff"), grey], textBlocks: [{ ...base, fontSizePx: 19 }] }),
  );
  assert.equal(thin19.length, 1, "19px 非粗體要用 4.5:1，3.03 過不了");

  const bold19 = analyzeContrast(
    facts({
      colors: [color("surface", "#ffffff"), grey],
      textBlocks: [{ ...base, fontSizePx: 19, fontWeight: 700 }],
    }),
  );
  assert.equal(bold19.length, 0, "19px 粗體才算大字，3:1 過得了");

  const large = analyzeContrast(
    facts({
      colors: [color("surface", "#ffffff"), grey],
      textBlocks: [{ ...base, fontSizePx: 24, fontWeight: 400, isHeading: false }],
    }),
  );
  assert.equal(large.length, 0, "24px 任何字重都算大字");
});

test("對比取最差底色，不是只看 surface", () => {
  // background 白、surface 黑、字灰：只看 surface 會得到 9.04 而漏報，
  // 但這個字疊在白底上只有 2.32。schema.ts 早就記錄過同一個反例。
  const result = analyzeContrast(
    facts({
      colors: [
        color("background", "#ffffff"),
        color("surface", "#000000"),
        color("text-primary", "#aaaaaa"),
      ],
      textBlocks: [
        { id: "body", label: "內文", fontSizePx: 16, lineHeight: 1.6, charsPerLine: 60, isHeading: false },
      ],
    }),
  );
  assert.equal(result.length, 1, "最差情況不及格就要報");
  assert.match(result[0].evidence, /2[.]3[0-9]:1/, `應取最差值，實得：${result[0].evidence}`);
  assert.match(result[0].evidence, /#ffffff/, "要說明是對哪個底色算的");

  // 反過來排一次：這樣「取第一個底色」與「取最差底色」才分得出來
  //（變異測試指出上面那組的第一個剛好就是最差的，所以殺不死「取第一個」）。
  const reversed = analyzeContrast(
    facts({
      colors: [
        color("background", "#000000"),
        color("surface", "#ffffff"),
        color("text-primary", "#aaaaaa"),
      ],
      textBlocks: [
        { id: "body", label: "內文", fontSizePx: 16, lineHeight: 1.6, charsPerLine: 60, isHeading: false },
      ],
    }),
  );
  assert.equal(reversed.length, 1, "順序不該影響結果");
  assert.match(reversed[0].evidence, /2[.]3[0-9]:1/, `取第一個底色會得到 9.04，實得：${reversed[0].evidence}`);
  assert.match(reversed[0].evidence, /surface/, "最差的是 surface(#ffffff)");
});

test("色彩角色對不到色票時說算不出來，不沉默跳過", () => {
  const result = analyzeContrast(
    facts({
      colors: [color("surface", "#ffffff"), color("text-secondary", "#cccccc")],
      textBlocks: [
        { id: "body", label: "內文", fontSizePx: 16, lineHeight: 1.6, charsPerLine: 60, isHeading: false },
      ],
    }),
  );
  assert.equal(result.length, 1, "沉默跳過會讓人以為「檢查過沒問題」");
  assert.match(result[0].issue, /找不到/);
  assert.match(result[0].evidence, /text-secondary/, "要說明目前有哪些角色可用");
});
