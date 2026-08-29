# WB04 對抗審查 — Claude 逐項裁決

兩路獨立審查：

- **Claude 自審 workflow**（4 面向找缺陷 → 每條由「預設反駁」的懷疑者驗證，
  34 agents）：30 條 findings，**21 條存活、9 條被反駁**。
- **Grok 對抗輪**：verdict **MUST_FIX**，3 條，全部與自審重疊（獨立雙重確認）。

裁決：**21 條全部接受、全部修復**（含 2 條「做了但不完整」的誠實記錄）。
原始資料：`self-review-findings.json`、`grok-findings.json`。

## 最嚴重的一條：我在 WB04 親手開的隱私洞

**[high] presence 走非 private channel — 姓名與所在板外洩給房外**

Realtime 的 presence 沒有 RLS（postgres_changes 有）。topic 名稱只含房間
uuid，而房間 uuid 就在邀請連結裡；任何人拿著它加上公開的 anon key 就能
join 這個 topic。WB04 之前 payload 是 `{ at }`，外人最多推得出人數；我把
**姓名**和**開著哪塊板**放進去之後，等於把成員名單 publish 出去。

**修法**：姓名不上線路。payload 只留 `{ at, boardId }`（userId 本來就是
presence key），姓名改在客戶端用房內**已受 RLS 保護**的資料對照 —— 討論
訊息的作者、節點上的最後寫入者戳記。對照不到就顯示「夥伴」，不假裝知道。

**沒做但該記**：把 channel 改成 `private: true` ＋ `realtime.messages` 的
RLS 政策才是根治（連 boardId 都不外流）。沒做的原因是誠實的：本機的
migration probe 環境沒有 realtime schema，這條政策**驗證不了** —— 我不想
交付一個測不到的安全宣稱。列為後續，需要在真專案上驗。

## 即時收斂（4 條）

- **[high] frames 自我 echo 蓋掉更新的本地值**：版本護欄寫成 `<`（非嚴格），
  而 `adoptFrameVersion` 只採納版本號、保留本地座標 —— 正好造出「本地 v6
  座標新 vs echo v6 座標舊」的相等版本狀態，於是整列被自己的廣播蓋回去。
  節點路徑早就有 inFlight ∪ dragging 兩層護盾＋嚴格 `>`，frames 兩者皆無 ——
  等於把節點當年踩過的坑原樣重踩。修：改嚴格 `>`、加 in-flight 護盾
  （送出到 ack 之間一律讓路）。
- **[high] 斷線重連只補 nodes/edges，frames 不自癒**：`loadWhiteboardGraph`
  不含 frames，三條自癒路徑（reconnect / visibilitychange / retry）因此都
  漏了它 —— 回到前景看到的是斷線前的標題與位置，且不會再收斂。修：新增
  `setReviveHandler`，重連時一併重讀 frames（`keepCurrent` 避免閃空）。
  （驗證者同時**反駁**了這條指控的後半段「佇列中毒」：我先前修 Grok F2 時
  已讓 frame stale-write 不進重試佇列。誠實記錄：只有前半成立。）
- **[medium] `loadFramesForBoard` 沒有請求序號**：弱網下慢回應會蓋掉「載入
  視窗內抵達的即時事件」，切板時還會把別塊板的 frames 灌進來 —— 更糟的是
  接著存快照會存成**空的 frames**，日後還原那個版本就等於把現有區塊全刪。
  修：請求序號＋落地時比對 boardId，過期回應丟棄。
- **[medium] edge UPDATE 訂閱目前是死碼**：客戶端沒有任何修改既有 edge 的
  寫入路徑。誠實記錄（見 design.md）：訂閱與版本護欄是先備好的收斂規則，
  單元測試驗的是合併規則本身、不是功能。

## 版本歷史（7 條）

- **[high] `onRestoreVersion` 是 fire-and-forget，卻回報「已還原」**：內部
  沒有任何 await，離線或全部失敗也照樣顯示成功。修：回傳
  `{ applied, queued }`，UI 只說真話 —— 離線時說「會在回網後送出」。
- **[medium] 本機房照樣顯示版本入口**：註解寫「只在雲端房提供」，handler
  卻是無條件掛上的，按下去只會拿到「請再試一次」。修：三個 handler 用
  展開式條件掛載，Workspace 的入口判斷就是「handler 在不在」。
- **[medium] `SNAPSHOT_NODE_LIMIT` 是死常數**：0025 的 CHECK 擋 2000 節點，
  常數導出了卻零引用 —— 大板存快照永遠失敗，訊息還叫使用者一直重試。
  修：存之前先檢查，超過就直說。
- **[medium] 開一次版本歷史下載 20 份完整快照**：註解寫「不取 snapshot」，
  實際是 `.select("*")`；而且 `planRestore` 寫在 `.map` 的 render 路徑裡，
  每次 render 重跑 20 次。修：清單只取 metadata，點下去才取那一份快照，
  預覽（含「還原會發生什麼」）只算一次。
- **[medium] 還原不清 undo/redo 疊**：還原後按「重做」會把剛還原掉的編輯
  再套回去（drift 防護剛好放行 —— 因為還原把值變回 `draft.before` 了）。
  修：還原完成後清空 history 疊。
- **[low] `sameNodeShape` 用 `JSON.stringify` 比 content**：快照經過 jsonb
  會被重排鍵序，於是「零變化」被算成大量改寫。修：穩定序列化（鍵排序）。
- **[low] `listBoardVersions` 不驗元素形狀**：畸形快照會產出 `id: undefined`
  的 payload → PostgREST 400 → 進重試佇列反覆重放。修：`sanitizeSnapshot`
  逐筆驗形狀，丟掉的筆數回報給 UI（預覽會顯示「有 N 筆格式不符，已略過」）。

## Presence（其餘 4 條）

- **[high] 首次 track 永遠帶 `boardId: null`**（Grok F3 同）：用 `&board=`
  連結直接進板的人，在所有人眼中都不在板上。修：改由 `getPresenceIdentity()`
  現查，不留可能過期的副本。
- **[medium] presence key 用 `getUser()`（可能回 "anon"）、自我過濾用
  `ensureSession()` 的 id**：兩者分歧時使用者會在「也在這塊板」看到自己。
  修：兩邊同源。
- **[medium] `presenceState` 的 metas 取最後一筆**＝最後 join 的 socket，
  不是最新 track —— 同一人開兩個分頁時會從名單整個消失。修：取 `at` 最大的。
- **[medium] `presencePeople` 從不清空**：斷線／切房 unsubscribe 後名單
  凍結在最後一次 sync。修：cleanup 時清空。
- **[low] 名字只放在 `title` tooltip**：手機優先的產品，主平台上沒有 hover
  ——「具名在場」退化成人頭數。修：名字直接顯示在頂列，數字與名單同語意。

## History 協調器（2 條，都是我 WB04 新寫的序號機制）

- **[high] `selfConsume` 洩漏後吞掉真正的返回**：`history.back()` 有可能
  根本不產生 popstate（已在最舊一格／導覽被取消），那筆期待若永遠留著，
  之後使用者真的按返回時會被它吞掉 —— 兩層都關不掉、`onBack` 完全沒被
  呼叫。修：期待帶時間戳，超過 2 秒視為沒發生（時鐘可注入，反例測試在）。
- **[high] 重新整理後 `seqCounter` 歸零**：舊格的 `__seq` 比新層大 → 按返回
  落在「序號更大」的格被判成 forward → 連按兩次白板紋風不動。修：建立時
  從當前 `history.state.__seq` 接續序號。

## 測試基礎建設（1 條，最值得記的）

**[low] 我的新單元測試用錯誤型別呼叫 `applyBoardPatches`，而且永遠不會紅**

`scripts/` 不在 tsconfig 的 include 裡 —— 測試本身從來沒被型別檢查過。我
那條測試把第 3 個參數（`Map<string, number>`）傳成 `0`、還漏了第 5 個參數，
執行時剛好沒走到那條路徑所以是綠的。**沒被檢查的測試等於少一層保障。**

修：新增 `tsconfig.scripts.json`（Node＋DOM 型別）涵蓋白板這幾輪的測試，
`npm run typecheck` 一次跑兩個設定檔，並接進 `build`／`build:local`（CI 會
因此擋下測試的型別錯誤）。範圍誠實：其餘既有測試檔有先前就存在的型別錯誤
（`DiscussionMessage.kind` 用 `string`、`globalThis` 索引等），清乾淨屬
獨立的整理工作，沒有混進本輪。

## 被反駁的 9 條（誠實記錄）

包含「presence sync 陣列重繪造成效能問題」（實際是無代價的 micro-opt）、
「frames 佇列中毒」（先前修 Grok F2 時已擋掉）、「還原 30 筆衝突風暴」的
部分情境等。反駁理由都在 `self-review-findings.json` 的驗證欄位裡。

## 額外修掉的啟動崩潰（自己造成、被 e2e 抓到）

`nameByUserId` 的 useMemo 讀了宣告在它之後的 `roomRef` → TDZ
ReferenceError → **整個 App 白畫面**。e2e 第一個 `page.fill` 就逾時，
0/1 通過。改讀 `room` 本身（deps 已經追蹤它）。
單元測試看不到這種錯，是 e2e 擋下來的。

## 修復後驗證

`npm run typecheck`（兩個設定檔）乾淨；單元 **210**；migrations **288/288**；
collab e2e **80/80**（含「還原前先說清楚會發生什麼」新斷言）；
multi-branch **54/54**（預設埠與覆寫埠皆通過）；asset-intelligence 12 PASS；
視覺 **12/12**；build 綠。
