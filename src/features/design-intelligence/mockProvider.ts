/**
 * Design Intelligence — mock provider（PR-DI-02）
 *
 * **這不是一個 AI。** 它是一個確定性的假 provider，存在的理由有兩個：
 *
 * 1. 讓分析流程可以在沒有金鑰、沒有網路的情況下被完整測試（包含失敗路徑）。
 * 2. 當作 `DesignAnalysisProvider` 介面的參考實作。
 *
 * 它的 `id` 就叫 `mock`，而且 `analyze()` 回的 `model` 是 `null` ——
 * 任何把它的輸出當成真 AI 結果顯示給使用者的呼叫端都是錯的，
 * 而且從 id 就看得出來。任務書禁止「假裝已連線」，所以這個檔案刻意讓
 * 「這是假的」無法被藏起來。
 */
import type {
  AnalysisRequest,
  AnalysisResponse,
  Capability,
  DesignAnalysisProvider,
  ProviderStatus,
} from "./providers";

export type MockBehaviour =
  | { kind: "ok" }
  /** 模擬 provider 掛掉。用來驗證「本地診斷不會跟著消失」。 */
  | { kind: "throws"; message: string }
  /** 模擬回了東西但格式不合。用來驗證 schema 驗證真的會擋。 */
  | { kind: "garbage" }
  /** 模擬三個方案其實只改了顏色。用來驗證多樣性檢查真的會擋。 */
  | { kind: "shallow-alternatives" }
  /** 模擬慢回應，配合 AbortSignal 驗證取消。 */
  | { kind: "hangs" };

export type MockProviderOptions = {
  capabilities?: Capability[];
  status?: ProviderStatus;
  behaviour?: MockBehaviour;
};

export function createMockProvider(options: MockProviderOptions = {}): DesignAnalysisProvider {
  const capabilities = options.capabilities ?? [
    "text-analysis",
    "structured-output",
    "layout-analysis",
    "color-analysis",
  ];
  const status = options.status ?? { state: "ready" as const };
  const behaviour = options.behaviour ?? { kind: "ok" as const };

  return {
    id: "mock",
    capabilities: () => capabilities,
    status: async () => status,
    analyze: async (request: AnalysisRequest): Promise<AnalysisResponse> => {
      if (behaviour.kind === "throws") throw new Error(behaviour.message);

      if (behaviour.kind === "hangs") {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
          if (request.signal?.aborted) return onAbort();
          request.signal?.addEventListener("abort", onAbort, { once: true });
          // 刻意不 resolve：只有 abort 能結束它
        });
      }

      const base = {
        provider: "mock" as const,
        model: null,
        satisfied: capabilities,
        gaps: [],
        usage: { inputTokens: null, outputTokens: null },
      };

      if (behaviour.kind === "garbage") {
        return {
          ...base,
          raw: {
            diagnostics: [
              { issue: "配色可以更好" }, // 缺 location/impact/evidence/recommendation
              "這根本不是物件",
            ],
            alternatives: [{ name: "方案一" }], // 沒有 changes
          },
        };
      }

      if (behaviour.kind === "shallow-alternatives") {
        const colourOnly = (strategy: string, hex: string) => ({
          id: `alt-${strategy}`,
          name: `${strategy} 配色`,
          strategy,
          changes: [
            { dimension: "color", target: "主色", change: `改成 ${hex}`, reason: "看起來比較好" },
          ],
        });
        return {
          ...base,
          raw: {
            diagnostics: [],
            alternatives: [
              colourOnly("conservative", "#6157ef"),
              colourOnly("balanced", "#ff9f1c"),
              colourOnly("bold", "#00c48c"),
            ],
          },
        };
      }

      return {
        ...base,
        raw: {
          diagnostics: [
            {
              location: "海報上半部",
              issue: "標題與副標的字級只差 2px，看不出主從關係",
              impact: "第一眼抓不到重點，社群縮圖尺寸下更明顯",
              evidence: "標題 26px、副標 24px，比例 1.08（一般建議主標至少為副標的 1.5 倍）",
              recommendation: "標題放大到 40px，或把副標縮到 18px，讓比例達到 1.5 以上",
              severity: "major",
              confidence: 0.8,
            },
          ],
          alternatives: [
            {
              id: "alt-conservative",
              name: "只修可量測的問題",
              strategy: "conservative",
              changes: [
                {
                  dimension: "typography",
                  target: "主標題",
                  change: "字級 26px → 40px",
                  reason: "與副標拉開到 1.67 倍，主從關係才成立",
                },
              ],
              advantages: ["改動最小"],
              tradeoffs: ["視覺風格不變"],
            },
            {
              id: "alt-balanced",
              name: "重整資訊層級",
              strategy: "balanced",
              changes: [
                {
                  dimension: "typography",
                  target: "主標題",
                  change: "字級 26px → 44px，字重 600",
                  reason: "建立明確的第一層級",
                },
                {
                  dimension: "layout",
                  target: "整體版面",
                  change: "上方留白從 24px 增加到 64px",
                  reason: "把標題從邊緣推開，形成呼吸感",
                },
              ],
              advantages: ["主從關係清楚", "不需要換素材"],
              tradeoffs: ["內容區高度變少，長文案需要刪減"],
            },
            {
              id: "alt-bold",
              name: "以圖像為主的重構",
              strategy: "bold",
              changes: [
                {
                  dimension: "imagery",
                  target: "主視覺",
                  change: "改為滿版照片，文字疊在下三分之一",
                  reason: "縮圖尺寸下圖像的辨識度高於文字",
                },
                {
                  dimension: "typography",
                  target: "主標題",
                  change: "字級 26px → 56px，反白",
                  reason: "疊在照片上需要更強的量體",
                },
                {
                  dimension: "layout",
                  target: "整體版面",
                  change: "從置中對齊改為左對齊的三欄網格",
                  reason: "左對齊在窄螢幕上比置中好掃讀",
                },
                {
                  dimension: "copy",
                  target: "副標",
                  change: "從 28 字縮到 12 字以內",
                  reason: "疊圖時字數多會蓋掉畫面",
                },
              ],
              advantages: ["縮圖辨識度最高", "與同類作品拉開差異"],
              tradeoffs: ["需要一張夠好的主視覺照片", "改動最大，要重新對品牌規範"],
            },
          ],
        },
      };
    },
  };
}
