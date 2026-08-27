# Claude 裁決 — PR-02d（ContextAnchor 契約層）Grok round

日期：2026-08-28 ｜ 分支：feat/context-anchor-layer ｜ PR #53
Grok findings：`grok-findings-02d.json`（Grok CLI 1.0.5，scratchpad read-only 審查，verdict MUST_FIX）

## 裁決總表

| # | Grok 判定 | 裁決 | 處置 |
|---|-----------|------|------|
| F1 | high/blocking：anchorFromNode 漏了 placeBranch 的 branch link＋startTime 形狀，seek 語意丟失 | **接受** | 已修（a68a97d，與 Claude 自審獨立收斂同一缺陷） |
| F2 | medium：測試只 assert type、缺邊界 fixture，釘不住宣稱的逐欄形狀 | **接受** | 已修（收緊＋4 個邊界 fixture） |

## F1 — 獨立收斂

Grok 審查的 diff（887ebcf）與我在其審查期間的自審各自發現同一缺陷：
板上「影片段落」節點是 `placeBranch` 寫的 **branch** link＋content.startTime，
不是 version link；原 adapter 把它讀成 entity-branch，openTarget 回 content
但**不帶 startTime** — 契約無法把既有 seek 語意交給 setOpenAtSeconds。

修法（a68a97d）：`anchorFromNode` 對 version 與 branch link 都升級 video 錨，
各帶自己真實知道的 id（version→versionId、branch→branchId，不互相捏造）；
`anchorToNodeLink` video 臂 branch 優先（可導航的那個事實），無 branch 才寫
version。板上「打開內容」按鈕改走 openTarget；version link 的 asset 卡契約
誠實回 none（Grok 確認：舊 `onOpenContent(versionId)` 在 branchForId 本來
就是 no-op），保留舊 fallback 維持行為中立。

Grok 同輪也確認了其餘攻擊面守住：委派後 comment 讀寫與舊 codec 同義
（startsWith 大小寫、0 合法、end==start 變 point、字串 region 落 null）、
RoomDiscussion 按鈕被 kind gate 保護不被 none 吞掉、createNode spread 不
覆蓋 content、lib→features/collaboration/types 為葉模組無環。

## F2 — 測試收緊

- legacy region / 負寬 region / 優先序三個測試由 `assert.equal(type)` 改
  `deepEqual` 全形狀（region 本體、x/y、nodeId 不再能被丟棄而不紅）。
- 新增邊界 fixture：`time_seconds=0`（合法時刻）、`end==start`（讀成
  point）、`anchor_type` 大寫不認（與舊 codec 同義，記為刻意的大小寫
  敏感）、region 為 JSON 字串（normalizeRegion 不認 → point）。
- F1 的 branch＋startTime 節點 fixture 已在 a68a97d 加入（round-trip＋
  openTarget 帶 startTime＋寫回 branch link）。

## 證據

unit 72/72（context-anchor 25）；build 綠；collab e2e 34/34、multi-branch
21/21（a68a97d 前跑過，本輪只動測試與已驗證的 adapter 分支）。CI 以
PR #53 最終 head 為準。

## 結論

blocking F1 已修且有獨立收斂佐證；F2 全數落實。本輪可進 merge gate。
