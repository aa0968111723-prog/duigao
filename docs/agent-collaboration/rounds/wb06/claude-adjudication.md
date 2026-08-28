# WB06 對抗審查 — Claude 逐項裁決

兩路獨立審查：

- **Grok 對抗輪**：verdict **MUST_FIX**，4 條。
- **Claude 自審 workflow**（3 面向＋懷疑者驗證，34 agents）：31 條 findings，
  **12 條存活、19 條被反駁**。

裁決：**全部接受、全部修復**。原始資料：`grok-findings.json`、
`self-review-findings.json`。

## 紅線只守住了一半（Grok F1，最嚴重）

**[high] 房間層 AI 仍可一鍵把白板提案直接落板**

我在白板裡做了 Proposal→Preview→Apply，卻把**舊路留著**：房間層 AI 面板的
`add_whiteboard_node` 按下去仍是直接 `upsertNode`，沒有預覽、沒有快照。
使用者從 AI 面板進來時，「AI 不自動執行」這條紅線等於不存在。

修法：房間層那條路徑改成**開板 ＋ 把提案交給白板預覽**，重用同一套確認
流程。`asset-intelligence` e2e 的斷言原本叫「套用白板提案走 0014 production
node」—— 那句話現在描述的是已不存在的行為，改成驗新的紅線：按下後板上
**沒有**真節點、只有預覽，確認後才成為節點。

## 預覽畫在看不見的地方（Grok F3 ＋ 自審，同一條）

**[high] `screenCenterWorldRef` 從宣告到讀取之間沒有任何寫入**

註解寫「Workspace 在問 AI 時回報目前視野中心」，但呼叫端根本沒傳。於是
origin 恆為世界座標 (120,120)：使用者平移到板的另一區問 AI，底部確認列
寫著「會加上 2 個便利貼」，畫面上一個虛線都看不到 —— **只能盲按套用**。
紅線被繞過的第二種方式。修：Workspace 把
`screenToWorld(camera, viewport/2)` 一起送上去。

## 套用之後撤不掉、快照失敗也照樣寫（Grok F2）

- 套用**不進 undo 疊** → ↺ 撤不回 AI 放上來的東西。
- 快照失敗（離線／超過 2000 節點／RLS）仍照樣寫入 → 「已套用但沒有可回去
  的版本」。

修：套用後把每個節點的 create draft 推進 history，↺ 可以一鍵撤回；訊息
誠實區分有沒有存到快照。兩者合起來讓「快照沒成功」不再是死路。

## 連點與換板（Grok F4）

- `setAiBusy(true)` 是非同步的，連點兩次會寫**兩批**節點 → 加 in-flight ref。
- 預覽期間換板：節點帶的是舊板 id、快照存的是新板 → App 端拒絕
  `whiteboardId` 與目前板不符的計畫；Workspace 切板時清掉**不屬於這塊板**
  的預覽。
  - 這裡踩到一個自己造的坑：一開始寫成「切板無條件清空預覽」，結果房間層
    AI 的「開板＋暫存預覽」是同一次 commit，預覽當場被抹掉（e2e 抓到）。

## 隱私：被關掉 AI 的素材，檔名照樣進了外部模型（自審）

**[medium] 板上 AI 把素材節點標題直接塞進 query，繞過 `external_ai_allowed`**

房主把某素材的「AI 讀取」關掉 → 有人把它拖上白板（節點標題＝檔名）→
在板上問 AI。伺服器端的政策閘只檢查 `selected` 那批資產，而板上的素材
節點根本不在其中 —— 檔名就這樣進了 prompt。

修：客戶端先濾 —— 連到 version/asset 且該素材不允許 AI 讀取的節點，
文字一律不送，也不進 `selectedBranchIds`。

## 佇列毒化：AI 給的 link 沒驗就寫進 uuid 欄位（自審）

AI（或被注入的 agent 回應）回一個
`linkedEntityId: "poster-1"` → 預覽看起來只是一張普通便利貼（幽靈不顯示
link）→ 套用 → PostgREST `22P02 invalid input syntax for uuid` → 進 durable
重試佇列 → **每次 flush 都重放、每次都失敗**。與 WB04 修過的畸形快照是
同一種毒化，只是來源換成 AI。修：link id 非 uuid 就整個丟掉 link。

## 兩句不老實的話（自審）

- **稽核失敗被完全吞掉**：`void recordAiApplyAudit(...)` 沒有 `.then`，
  而房間層那條路徑早就有 toast。0019 一列都沒寫，卻沒有人被告知 ——
  設計文件寫的「人看得到、機器也查得到」只剩前半。
- **離線時說「已套用 N 項」**：實際只是進了 pending 佇列。WB04 的還原路徑
  早就有 `queued` 欄位分得出差別，WB06 沒有。

修：回傳 `{ applied, snapshotTaken, queued, auditRecorded }`，訊息把三件事
分開講 —— 離線是「會在回網後送出」，快照／稽核沒成功都明說。

## e2e 假綠（自審，第四次同類問題）

驗證者指出：**把實作改成「預覽時順手 insert 節點」或「留言提案也送進
討論串」，這章仍會全綠。** 具體四點：

1. 「非白板提案不會混進板上預覽」重複斷言同一個 `previewCount`，沒有新觀察。
2. 「真節點數沒有變」只數 DOM，同一支檔案別處明明就在直查 `rows.whiteboard_nodes`。
3. 章節標題寫「→ 稽核」，但 `collaboration_audit_events` 一列都沒驗。
4. design.md 主張「預覽不持久」，e2e 從頭到尾沒驗過。

修：加 DB 層基準比對（節點表／討論表）、驗留言文字沒出現在幽靈裡、
驗稽核表有增長、關板再開驗預覽沒復活。
（不用 `page.reload`：這個 e2e 的房是本機建的，重整會回首頁 —— 那樣驗到的
是「回首頁沒有預覽」而不是「預覽不持久」。）

## 其餘

- **[low] 在 AI 面板按取消不會取消進行中的提問**：關掉 sheet 後結果回來，
  預覽自己冒出來。修：提問序號，在途結果作廢。
- **[low] `describePreview` 對沒列舉到的型別吐英文 enum**：修成說人話。
- **[low] 只是「預覽」就把整塊板的文字寫進 IndexedDB 快取**：**未修**，
  誠實記錄 —— 這是既有 `askRoomContext` 的快取行為（5 分鐘），不是 WB06
  引入的；要動它得一併處理房間層 AI 的快取語意，屬獨立工作。

## 被反駁的 19 條

包含大量提案的效能推論、預覽節點被 marquee 選到（實際上 `paintOrder` 只吃
房態節點）、AI 套用與版本還原的互動等。理由都在
`self-review-findings.json` 的驗證欄位。

## 修復後驗證

`npm run typecheck` 乾淨；單元 **221**；migrations **288/288**；
collab e2e **110/110**（WB06 十五條，含五條新的 DB 層真斷言）；
asset-intelligence e2e **14**（含房間層紅線的兩條新斷言）；
multi-branch **54/54**；視覺 **15/15**；build 綠。
