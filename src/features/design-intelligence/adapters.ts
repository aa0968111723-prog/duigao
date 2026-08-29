/**
 * Design Intelligence — 外部工具契約（PR-DI-05）
 *
 * **這個檔案只定義契約與轉譯，不呼叫任何外部服務、不套用任何東西。**
 *
 * 每個 adapter 做三件事，而且只做這三件：
 *   1. 誠實回報**現在有沒有真的連上**（任務書禁止「假裝 Canva、CUTOS 或
 *      Perplexity 已連線」）。
 *   2. 把一個方案轉譯成該目標看得懂的 payload，**並驗證它**。
 *   3. 說出這個 payload 可不可逆、怎麼逆。
 *
 * 「套用」不在這裡。`lifecycle.ts` 的 `transitionProposal` 是唯一能讓提案進入
 * `applying` 的路，而它要求：有人核准過、有可逆的 patch、有基準版本。
 *
 * ## 為什麼不擴充既有的 AI 動作白名單
 *
 * 同一份四值白名單（`create_comment` / `create_poll` / `create_plan_draft` /
 * `add_whiteboard_node`）在 repo 裡寫了三次，其中一份在 edge function 裡，
 * 而 edge function 在本分支的「不應修改」清單內（見 handoff H-3）。
 *
 * 所以白板 adapter **轉譯**成既有的 `add_whiteboard_node`，不新增動作型別。
 * 既有白名單一行都不用改。
 */
import { canTransition } from "./schema";
import type { DesignAlternative, DesignPatch, DesignProposal } from "./types";

/** adapter 現在的真實狀態。**沒設定就說沒設定。** */
export type AdapterStatus =
  | { state: "ready" }
  /** 缺設定。`missing` 列出缺什麼（名稱，不含值）。 */
  | { state: "unconfigured"; missing: string[] }
  /** 設定好了但目前用不了。 */
  | { state: "unavailable"; reason: string; retryable: boolean }
  /** 這個 adapter 在本階段只有契約，沒有實作。**這是誠實，不是失敗。** */
  | { state: "contract-only"; note: string };

export type BuildResult =
  | { ok: true; patch: DesignPatch; warnings: string[] }
  | { ok: false; reason: string };

export interface DesignTargetAdapter {
  readonly id: DesignPatch["adapter"];
  readonly label: string;
  /** 目前真的能不能用。 */
  status(): Promise<AdapterStatus>;
  /** 這個 adapter 處理得了這份提案嗎（作品類型對不對）。 */
  accepts(proposal: DesignProposal): boolean;
  /** 把一個方案轉譯成可執行的 patch。**不執行。** */
  buildPatch(proposal: DesignProposal, alternativeId: string): BuildResult;
}

// ---------------------------------------------------------------------------
// 共用檢查
// ---------------------------------------------------------------------------

function selectAlternative(
  proposal: DesignProposal,
  alternativeId: string,
): DesignAlternative | null {
  return proposal.alternatives.find((item) => item.id === alternativeId) ?? null;
}

/**
 * 所有 adapter 共用的前置檢查。
 *
 * 最重要的一條：**提案的狀態必須有辦法走到 applying**。用的是同一個狀態機
 * （`canTransition`），不是各自寫一份條件判斷 —— 各寫一份就會走樣，
 * 而走樣的那一份就是繞過紅線的路。
 */
export function guardBuild(
  proposal: DesignProposal,
  alternativeId: string,
): { ok: true; alternative: DesignAlternative } | { ok: false; reason: string } {
  const alternative = selectAlternative(proposal, alternativeId);
  if (!alternative) return { ok: false, reason: "找不到這個方案" };
  if (!alternative.changes.length) return { ok: false, reason: "這個方案沒有任何具體改動" };

  // 產生 patch 本身不需要核准（要先看預覽才能決定要不要核准），但這個狀態
  // 必須真的有機會走到 applying —— 現在就能走，或核准之後能走。
  //
  // 這一條同時涵蓋了「已結束的提案」：applied / rejected / reverted 在狀態機
  // 裡都是終點，走不到 applying 也走不到 approved。原本另外寫了一個
  // `terminal` 判斷，變異測試證實它永遠不會改變結果（拿掉它測試全綠）——
  // 那就是重複的真相來源，而重複的那一份遲早會走樣。狀態機說了算。
  const reachable =
    canTransition(proposal.status, "applying") ||
    (canTransition(proposal.status, "approved") && canTransition("approved", "applying"));
  if (!reachable) {
    return { ok: false, reason: `「${proposal.status}」狀態下的提案不會被套用` };
  }
  return { ok: true, alternative };
}

// ---------------------------------------------------------------------------
// 白板：轉譯成既有的 add_whiteboard_node，不擴充白名單
// ---------------------------------------------------------------------------

/** 白板 sticky 的預設尺寸（與 `features/collaboration/nodes` 的既有值一致）。 */
const STICKY = { width: 180, height: 96, gap: 16 };

export const whiteboardAdapter: DesignTargetAdapter = {
  id: "board",
  label: "白板",
  async status() {
    // 白板是本地功能，沒有外部依賴。
    return { state: "ready" };
  },
  accepts: (proposal) => proposal.targetType === "board" || proposal.targetType === "plan",
  buildPatch(proposal, alternativeId) {
    const guard = guardBuild(proposal, alternativeId);
    if (!guard.ok) return guard;
    const { alternative } = guard;

    // 每一條改動變成一張便利貼。**內容是改動本身**，不是 AI 的敘述 ——
    // 白板上要留下的是「要做什麼」，不是「AI 說了什麼」。
    const nodes = alternative.changes.map((change, index) => ({
      // 走既有的四值白名單，不新增動作型別（handoff H-3）
      action: "add_whiteboard_node" as const,
      nodeType: "note",
      text: `${change.target}：${change.change}`,
      note: change.reason,
      x: (index % 3) * (STICKY.width + STICKY.gap),
      y: Math.floor(index / 3) * (STICKY.height + STICKY.gap),
      width: STICKY.width,
      height: STICKY.height,
    }));

    return {
      ok: true,
      warnings:
        alternative.changes.length > 9
          ? [`${alternative.changes.length} 條改動會產生同樣多的便利貼，白板上會很擠`]
          : [],
      patch: {
        adapter: "board",
        payload: { nodes, alternativeId, sourceProposalId: proposal.id },
        reversible: true,
        revertHint: `刪除這次新增的 ${nodes.length} 張便利貼即可回到原狀`,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Canva：契約與 mock，不做 OAuth、不呼叫 API
// ---------------------------------------------------------------------------

export type CanvaAdapterDeps = {
  /** 目前這個使用者有沒有連上 Canva。由 `agent/canva-oauth-production` 提供。 */
  isConnected: () => Promise<boolean>;
};

export function createCanvaAdapter(deps: CanvaAdapterDeps): DesignTargetAdapter {
  return {
    id: "canva",
    label: "Canva",
    async status() {
      // **不假裝已連線。** 沒連上就說沒連上，而且說得出要做什麼。
      const connected = await deps.isConnected();
      if (!connected) {
        return { state: "unconfigured", missing: ["Canva 授權"] };
      }
      return {
        state: "contract-only",
        note: "已連線，但把設計提案寫回 Canva 的實作屬於 canva-oauth 工作線；本階段只產生 payload",
      };
    },
    accepts: (proposal) => proposal.targetType === "poster",
    buildPatch(proposal, alternativeId) {
      const guard = guardBuild(proposal, alternativeId);
      if (!guard.ok) return guard;
      const { alternative } = guard;

      // Canva 的 API 不接受「把版面改成這樣」這種指令，只接受具體的元素操作。
      // 我們現在**還不知道**元素 id，所以產生的是一份「給人照著改的清單」，
      // 而不是假裝可以自動套用。
      const instructions = alternative.changes.map((change) => ({
        target: change.target,
        change: change.change,
        why: change.reason,
        dimension: change.dimension,
      }));

      return {
        ok: true,
        warnings: [
          "Canva 端的自動套用尚未實作：這份 payload 目前只能當作清單給人照著改",
        ],
        patch: {
          adapter: "canva",
          payload: {
            designId: proposal.targetId,
            instructions,
            alternativeId,
            sourceProposalId: proposal.id,
          },
          // 沒有實作自動套用，就沒有自動還原。標成不可逆，
          // 而 lifecycle 會因此拒絕自動套用 —— 這正是我們要的。
          reversible: false,
          revertHint: "尚未支援自動套用，因此也沒有自動還原",
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CUTOS：影片分鏡。沿用既有的 capability envelope 形狀，不改那個檔案
// ---------------------------------------------------------------------------

export const cutosAdapter: DesignTargetAdapter = {
  id: "cutos",
  label: "CUTOS 影片",
  async status() {
    // CUTOS 的金鑰只存在 cutos-bridge edge function，client 永遠拿不到。
    // 所以 client 端無法自行判斷連線狀態 —— 誠實回報這件事。
    return {
      state: "contract-only",
      note: "CUTOS 的連線狀態只有 cutos-bridge 知道（金鑰不在 client）。本階段只產生 payload",
    };
  },
  accepts: (proposal) => proposal.targetType === "video",
  buildPatch(proposal, alternativeId) {
    const guard = guardBuild(proposal, alternativeId);
    if (!guard.ok) return guard;
    const { alternative } = guard;

    // 分鏡：每一條改動對應一個鏡頭的調整建議。
    // **不給秒數** —— 我們沒有讀過那支影片，編一個秒數出來就是幻覺。
    const shots = alternative.changes.map((change, index) => ({
      order: index + 1,
      target: change.target,
      adjustment: change.change,
      reason: change.reason,
      durationSec: null as number | null,
    }));

    return {
      ok: true,
      warnings: ["沒有讀過影片內容，因此不提供鏡頭秒數"],
      patch: {
        adapter: "cutos",
        payload: {
          projectId: proposal.targetId,
          shots,
          alternativeId,
          sourceProposalId: proposal.id,
          // CUTOS 的 export 需要人工核准（ADR-005 v2 的 requiresApproval）
          requiresApproval: true,
        },
        reversible: false,
        revertHint: "CUTOS 端的變更由 CUTOS 自己的版本管理負責",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// planform-iso：場佈。repo 內只有解析，沒有寫入端
// ---------------------------------------------------------------------------

export const planformIsoAdapter: DesignTargetAdapter = {
  id: "planform-iso",
  label: "planform-iso 場佈",
  async status() {
    return {
      state: "contract-only",
      note: "repo 內只有 planformArtifact.ts 的解析，沒有寫入端；實作屬場佈工作線",
    };
  },
  accepts: (proposal) => proposal.targetType === "plan",
  buildPatch(proposal, alternativeId) {
    const guard = guardBuild(proposal, alternativeId);
    if (!guard.ok) return guard;
    return {
      ok: true,
      warnings: ["planform-iso 沒有寫入端，這份 payload 目前無法被套用"],
      patch: {
        adapter: "planform-iso",
        payload: {
          projectId: proposal.targetId,
          notes: guard.alternative.changes.map((change) => `${change.target}：${change.change}`),
          alternativeId,
          sourceProposalId: proposal.id,
        },
        reversible: false,
        revertHint: "尚未支援自動套用",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 網站：CSS 變數的差異
// ---------------------------------------------------------------------------

/**
 * 只允許改 CSS custom property，不允許任意 CSS。
 *
 * 值用 **hex 的規則**驗，不是一個寬鬆的字元類。欄位叫 `hex`，就該是 hex ——
 * 自己探測時發現舊的字元類讓 `var(--evil)`、`expression(alert(1))`、
 * `calc(100% - 1px)` 全部通過。這些在正常流程裡進不來（值來自
 * `parseColorTokens`，那裡有 HEX_RE），但這一層不能假設呼叫端一定走過那條路
 * —— 「上游驗過了」是最常見的破口說法。
 */
const CSS_VAR_RE = /^--[a-z0-9-]+$/i;
const CSS_HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const websitePatchAdapter: DesignTargetAdapter = {
  id: "website",
  label: "網站樣式",
  async status() {
    // **不宣稱 ready。** 這一層產得出 CSS 變數的差異，但沒有任何東西會去
    // 套用它 —— 沒有寫入端，也沒有地方記錄「原本的值是什麼」。
    // 對抗審查指出舊版回 ready 且 reversible: true，那等於宣稱一個
    // 不存在的還原能力。
    return {
      state: "contract-only",
      note: "產得出 CSS 變數差異，但沒有寫入端；套用與還原需要能讀寫目標樣式的一方",
    };
  },
  accepts: (proposal) => proposal.targetType === "website",
  buildPatch(proposal, alternativeId) {
    const guard = guardBuild(proposal, alternativeId);
    if (!guard.ok) return guard;
    const { alternative } = guard;

    // 只接受色票裡的 cssToken → hex。
    //
    // **不從自由文字裡解析 CSS。** 讓模型的自由文字變成實際套用的樣式，
    // 等於給它一個直接改網站外觀的通道 —— 「把 body 的 display 設成 none」
    // 也是一段合法的 CSS。色票是結構化的、已經過 parseColorTokens 驗證的。
    const variables: Record<string, string> = {};
    const rejected: string[] = [];
    for (const token of alternative.designTokens) {
      if (!CSS_VAR_RE.test(token.cssToken)) {
        rejected.push(`不合法的 CSS 變數名稱：${token.cssToken.slice(0, 40)}`);
        continue;
      }
      if (!CSS_HEX_RE.test(token.hex)) {
        rejected.push(`不合法的色值：${token.hex.slice(0, 20)}`);
        continue;
      }
      variables[token.cssToken] = token.hex;
    }

    if (!Object.keys(variables).length) {
      return {
        ok: false,
        reason: rejected.length
          ? `沒有可以套用的樣式（${rejected.join("；")}）`
          : "這個方案沒有產生任何 design token，無法轉成網站樣式",
      };
    }

    return {
      ok: true,
      warnings: [
        ...rejected,
        "沒有記錄原本的變數值，因此無法自動還原 —— 套用端要先把現值存下來才算可逆",
      ],
      patch: {
        adapter: "website",
        payload: { variables, alternativeId, sourceProposalId: proposal.id },
        // **不可逆**。「把變數改回原值」聽起來像還原，但這裡根本沒有原值 ——
        // 那句話是空的。標成不可逆，lifecycle 就會拒絕自動套用，
        // 直到有人實作「先讀現值再寫新值」的那一端。
        reversible: false,
        revertHint: "尚未記錄原本的變數值，因此沒有自動還原",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 檔案脈絡：唯讀
// ---------------------------------------------------------------------------

/**
 * 檔案脈絡 adapter **只讀不寫**，所以它的 `buildPatch` 永遠失敗。
 *
 * 保留它是因為它有 `accepts` 與 `status`，讓「這件作品可以被分析嗎」
 * 有統一的問法。一個永遠回失敗的 buildPatch 比一個假裝能寫的好。
 */
export const fileContextAdapter: DesignTargetAdapter = {
  id: "none",
  label: "檔案脈絡（唯讀）",
  async status() {
    return { state: "ready" };
  },
  accepts: () => true,
  buildPatch() {
    return { ok: false, reason: "檔案脈絡是唯讀的，不能被套用" };
  },
};

// ---------------------------------------------------------------------------

export function adaptersFor(
  proposal: DesignProposal,
  all: readonly DesignTargetAdapter[],
): DesignTargetAdapter[] {
  return all.filter((adapter) => adapter.accepts(proposal) && adapter.id !== "none");
}
