/**
 * 提案面板的驗收 harness（PR-DI-04）。
 *
 * **只給測試用，不進正式 bundle。** 它由 `vite.harness.config.ts` 單獨打包，
 * 共用的 `vite.config.ts` 一行都沒有被改動 —— 那個檔案是別條工作線也在用的。
 *
 * 存在的理由：這個面板要在五個指定尺寸上被驗證（360×800、390×844、
 * 412×915、768×1024、820×1180），而把它接進 `App.tsx`（3171 行，
 * 其他工作線正在改）只為了跑驗收，風險遠大於收穫。
 *
 * 底下那塊「主畫面」不是裝飾：它是用來斷言「AI 面板沒有蓋住作品」的對象。
 * 驗收會用 `document.elementFromPoint` 檢查作品的中心點**真的**點得到 ——
 * 而不是檢查 DOM 裡有沒有那個節點。兩者的差別，白板那幾輪已經教過我。
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesignProposalPanel } from "../DesignProposalPanel";
import type { DesignProposal } from "../types";
import "../design-intelligence.css";
import "./harness.css";

const FIXTURES: Record<string, DesignProposal> = {};

function base(over: Partial<DesignProposal>): DesignProposal {
  return {
    id: "p-1",
    roomId: "room-1",
    projectId: "room-1",
    artifactId: null,
    targetType: "poster",
    targetId: "poster-1",
    mode: "improve",
    goal: "這張海報看起來不夠專業",
    contextSummary: "一張活動海報",
    diagnostics: [],
    alternatives: [],
    recommendedAlternativeId: null,
    preview: null,
    patch: null,
    rationale: "理由",
    sources: [],
    risks: [],
    confidence: 0.6,
    status: "ready",
    createdBy: "user-1",
    createdAt: 1,
    approvedBy: null,
    approvedAt: null,
    appliedAt: null,
    revertedAt: null,
    baseRevision: null,
    resultRevision: null,
    ...over,
  };
}

FIXTURES.full = base({
  diagnostics: [
    {
      id: "local-contrast-body",
      dimension: "color",
      measured: true,
      location: "活動說明內文",
      issue: "文字與背景的對比只有 2.32:1，低於一般內文門檻 4.5:1",
      impact: "內文在手機上、光線強的環境、或視力較弱的人眼中會讀不清楚",
      evidence: "量測：#aaaaaa 疊在最差的底色 surface（#ffffff）上 = 2.32:1",
      recommendation: "把 text-primary 從 #aaaaaa 改為 #767676（4.54:1，達標）",
      severity: "blocker",
      confidence: 1,
    },
    {
      id: "local-tap-cta",
      dimension: "interaction",
      measured: true,
      location: "報名按鈕",
      issue: "可點擊區域只有 20×20 CSS 像素，短邊低於 24",
      impact: "手機上手指容易點不到或誤觸旁邊的元素",
      evidence: "量測：20×20，短邊 20，WCAG 2.2 AA 下限 24×24",
      recommendation: "把「報名按鈕」的點擊區域放大到至少 24×24",
      severity: "major",
      confidence: 1,
    },
    {
      id: "ai-hierarchy",
      dimension: "typography",
      measured: false,
      location: "海報上半部",
      issue: "標題與副標的字級只差 2px，看不出主從關係",
      impact: "第一眼抓不到重點，社群縮圖尺寸下更明顯",
      evidence: "標題 26px、副標 24px，比例 1.08",
      recommendation: "標題放大到 40px，讓比例達到 1.5 以上",
      severity: "minor",
      confidence: 0.8,
    },
  ],
  alternatives: [
    {
      id: "alt-conservative",
      name: "只修可量測的問題",
      strategy: "conservative",
      changes: [
        { dimension: "color", target: "內文顏色", change: "#aaaaaa → #767676", reason: "量測 2.32:1，改後 4.54:1" },
        { dimension: "interaction", target: "報名按鈕", change: "20×20 → 48×48", reason: "量測短邊 20，下限 24" },
      ],
      designTokens: [],
      preview: null,
      advantages: ["每一項都對應一個量得出來的問題", "不動視覺風格"],
      tradeoffs: ["只解決合規與可讀性"],
    },
    {
      id: "alt-balanced",
      name: "重整資訊層級",
      strategy: "balanced",
      changes: [
        { dimension: "typography", target: "主標題", change: "26px → 44px，字重 600", reason: "建立明確的第一層級" },
        { dimension: "layout", target: "整體版面", change: "上方留白 24px → 64px", reason: "形成呼吸感" },
      ],
      designTokens: [],
      preview: null,
      advantages: ["主從關係清楚"],
      tradeoffs: ["內容區高度變少"],
    },
    {
      id: "alt-bold",
      name: "以圖像為主的重構",
      strategy: "bold",
      changes: [
        { dimension: "imagery", target: "主視覺", change: "改為滿版照片，文字疊在下三分之一", reason: "縮圖辨識度高" },
        { dimension: "layout", target: "整體版面", change: "置中改為左對齊三欄網格", reason: "窄螢幕好掃讀" },
        { dimension: "copy", target: "副標", change: "28 字縮到 12 字以內", reason: "疊圖時字數多會蓋掉畫面" },
      ],
      designTokens: [],
      preview: null,
      advantages: ["縮圖辨識度最高"],
      tradeoffs: ["需要一張夠好的主視覺照片", "改動最大"],
    },
  ],
  recommendedAlternativeId: "alt-conservative",
  risks: ["目前沒有可用的 AI 分析服務，以下只有本地量測得出的結果"],
});

FIXTURES.clean = base({});
FIXTURES.failed = base({
  status: "failed",
  risks: ["AI 分析沒有完成（mock：503 上游無回應），以下只有本地量測得出的結果"],
});
FIXTURES["needs-context"] = base({
  status: "needs-context",
  risks: ["沒有取得足以分析的資料：需要作品的色碼、字級或可點擊元素尺寸其中之一"],
});

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const fixture = FIXTURES[params.get("fixture") ?? "full"] ?? FIXTURES.full;
  const [applied, setApplied] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  }));

  // 旋轉與視窗改變時要重算版面 —— 橫放的手機不該突然變成分割檢視。
  useEffect(() => {
    const onResize = () =>
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
        coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div className="harness">
      {/* 這一塊是「作品」。驗收會檢查它的中心點真的點得到。 */}
      <main className="harness__artwork" data-testid="artwork">
        <h1>春季設計工作坊</h1>
        <p>這是一張測試用的海報。驗收會確認它沒有被 AI 面板蓋住。</p>
        <p data-testid="applied">{applied ? `已套用：${applied}` : "尚未套用任何方案"}</p>
      </main>

      {!dismissed && (
        <DesignProposalPanel
          proposal={fixture}
          viewport={viewport}
          canApply={params.get("canApply") !== "false"}
          onApply={(id) => setApplied(id)}
          onDismiss={() => setDismissed(true)}
          onRetry={() => undefined}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
