# Claude 裁決 — PR-02c（白板即時 row-patch）Grok round

日期：2026-08-28 ｜ 分支：feat/board-realtime-rowpatch-02c ｜ PR #52
Grok findings：`grok-findings-02c.json`（Grok CLI 1.0.5，worktree read-only 審查）

## 裁決總表

| # | Grok 判定 | 裁決 | 處置 |
|---|-----------|------|------|
| F1 | 拖曳護盾推進 ack ⇒ 拖完 persist 蓋掉遠端內容（silent LWW） | **接受（blocking）** | 已修 |
| F2 | 自己的 WAL echo（version=acked+1）早於 HTTP ack ⇒ 蓋掉第二鍵 | **接受（blocking）** | 已修 |
| F3 | heal 走 onSnapshot ⇒ 斷線期間的遠端 DELETE 永不落地 | **接受（blocking）** | 已修 |
| F4 | DELETE binding 無 room filter，依賴 replica identity | **接受風險、不改** | 記錄於下 |
| F5 | rAF 註解宣稱省 trackSave 不實；batch 未過濾他房 patch | **接受** | 已修 |
| F6 | 兩分頁 e2e 有恆真斷言、未證明非 heal 路徑 | **接受** | 已修 |

## 修正內容

**F1 — 護盾不再推進 ack。** `applyBoardPatches` 護盾語意改為「讓路且不推進」：
被護盾的節點跳過內容覆蓋、也跳過 ack 水位。拖曳結束的 persist 因此帶舊
acked version 去撞 OCC，輸了走 02b 的 drop+refetch（誠實 toast），永不
silent LWW。原本「讓路但推進」的單元測試已改寫為新語意。

**F2 — in-flight 護盾。** `App.persistCloud` 在送出前把 node id 加入
`inFlightNodeIds`，`try { await next } finally { delete }`。rAF flush 的
護盾集合 = 拖曳中 ∪ in-flight，自己的 WAL echo 在 HTTP ack 前到達也不會
蓋掉打字中的內容；ack 只由 HTTP 結果推進。
補充：02b 衝突分支在自己的 persist chain 內執行，該處先
`inFlightNodeIds.delete(node.id)` 再 refetch — 這趟航班已以衝突告終，
護盾若留著會把應被 drop 的本地內容保住、acked 永不前進，之後每筆都
409 空轉（e2e「同步後編輯恢復」抓到過此迴圈，已由該行修復）。

**F3 — heal 改走板級 wholesale replace。** `useCloudRoom` 新增
`onBoardReplace`，`loadWhiteboard` 優先走它；新純函式
`replaceBoardGraph`：以伺服器回傳的整板為準 — 遠端已刪節點消失、acked
對缺席的非護盾 id 清除、對在場的非護盾 id 推進到列版本；護盾節點（打字
中/in-flight）內容與 acked 皆保留。`retry()` 也對開著的板 heal 一次。

**F5 —** rAF 註解改為誠實描述（省的是 render，不是 IDB 寫；遠端 patch
本來就不走 trackSave）；flush 以 `patch.node.roomId === current.id` 過濾
他房 patch。

**F6 —** 兩分頁 e2e：「B 看到 A 的新節點」改為以 B 頁面實際 DOM 讀值斷言
（原本 waitForFunction 過了就 `check(true)` 恆真）；量測窗內同時斷言
`rooms?select=*` GET=0 **且** `whiteboard_nodes` GET=0 — 後者證明 B 收到
的是 realtime row-patch，不是 heal 的 loadWhiteboard 替代路徑。

## F4 — 接受風險不改的理由

`whiteboard_nodes`/`whiteboard_edges` 的 DELETE binding 用 `filter:undefined`
（Supabase realtime 對 DELETE 只保證 old record 含 replica identity 欄位；
room 欄位不保證在 payload 裡，帶 filter 會整條 binding 收不到事件）。
風險是「收到別房的 delete id」：patch 只以 id 刪本地陣列，別房 id 在本地
陣列中不存在 ⇒ no-op；同 id 跨房不可能（uuid PK）。攻擊面沒有擴大（RLS
不變，realtime 只送成員可見的 channel）。維持現狀，換取 DELETE 事件的
可靠送達。若日後 self-host realtime 支援 DELETE filter，再收緊。

## 新增測試

- unit：護盾中 persist 不得 LWW 蓋字（F1 語意，改寫原測試）
- unit：in-flight echo（acked+1）不得覆蓋較新本地 content、ack 不由 echo 推進
- unit：`replaceBoardGraph` — 遠端已刪節點消失、acked 清除、護盾節點保留
- e2e：F6 收緊如上；02b 全迴圈（409→refetch→落地）維持通過

## 回歸證據（wt7，本機）

- `test:collaboration` 47/47（含 3 新 unit）
- `test:collaboration-e2e` 34/34（含收緊後的兩分頁塊）
- `test:multi-branch` 9/9、`test:multi-branch-e2e` 21/21
- `test:agent` 16/16、`test:asset-intelligence` 15/15、`test:review-viewer` 27/27
- `agent:gate` PASS
- `test:video` 157/158 — check 23 本機失敗，但 **A/B：pre-fix 基底
  384389a（PR #52 CI 綠燈那顆）在本機同點同簽名失敗**（consumed=false，
  自癒重試 4 次仍在 metadata POST 前死亡）⇒ 環境性（本機負載），非本輪
  變更造成。以 CI 結果為準。

## 結論

三個 blocking findings 全數修復並補齊 Grok 要求的單元證據；F4 記錄為
已評估的接受風險。本輪可進 CI / merge gate。
