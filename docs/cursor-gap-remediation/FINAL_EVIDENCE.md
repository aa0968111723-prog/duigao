# Gap-remediation — incremental evidence（未完成）

核對時間：2026-08-29。**只列有權威證據的項目。** 全站目標未完成。本檔不是 merge／deploy 許可。

現行 `origin/main`：`3d8b2cf`（含已合併 #97）。

---

## 先前批次（GitHub live，本棧不重跑那些測試）

| 項 | 證據 |
|---|---|
| **#97** | Merged to main。`src/cloud/apiResponse.ts` 在 `origin/main`。 |
| **#96** | Open，`e163bb1`，對現行 main dirty。 |
| **#98** | Open，`af8c2a4`，dirty。 |
| **#99** | Open，`1e58056`，docs only。 |
| **#100** | Merged **into #95 stack**，不是 main，`782e586`。 |
| **#101** | Merged **into GAP-02**，不是 main，`4f966a3`。 |
| **#102 / GAP-05** | Open draft，`3622181`，base GAP-04。 |
| **GAP-06** | `cursor/p1-whiteboard-handoff-70d9` @ `851964f`，疊在 #78。 |

---

## GAP-07（本分支）

| 欄位 | 證據 |
|---|---|
| 分支 | `cursor/p2-ai-external-handoff-70d9` |
| Base 必須是 | `agent/design-intelligence-perplexity`（#88） |
| #88 | OPEN、**CONFLICTING**、head `32e3bca` |
| 實作 | `honesty.ts`；`analysis.ts` 海報／影片要 vision；`research.ts` 拒絕 SPA HTML |
| 沒做 | 重寫 schema／0027–0028；複製到 main；重做 #97 Canva parser |
| 測試 | `npm run test:ai-external-handoff`（本回合跑） |

Canva／CUTOS：**edge function 有 OAuth／API key 實作**；沒 env 回 `*_NOT_CONFIGURED`。#88 adapter 為 contract-only。Production secret **未在本回合驗證**。

---

## 仍 incomplete

- #88 rebase／renumber 0027–0028
- #78 CONFLICTING
- #95／#100–#102 不在 main
- 正式站 SPA catch-all
- Canva／CUTOS／Perplexity **是否已部署 secret**
- #88 Design Intelligence 尚未合入
- 全站目標
