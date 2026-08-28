# WB04 — 即時協作輪 設計與實作

盤點依據：四路平行讀者的 realtime／presence／版本／離線合併地圖，
加上我自己對 `roomSync.ts` 的直讀。

## 補上的即時缺口

1. **frames 沒有訂閱**（WB03 誠實記錄的洞）：`whiteboard_frames` 早在 0023
   就進了 `supabase_realtime` publication 且 replica identity full，但客戶端
   從未訂閱 — 別人建/移/刪的區塊，你要重開板才看得到。現在與節點同樣走
   row-patch（不觸發整房 reload）。
   - 收斂規則：版本較舊的 echo 丟棄，自己剛寫的樂觀值不會被自己的廣播蓋回。
2. **edges 只訂 INSERT/DELETE**（盤點抓到的）：0022 給 edges 加了
   `version`/`label`/`source_handle`/`target_handle`，但 UPDATE 沒有監聽 —
   別人改的線標籤在對方重載前都看不到。補上 UPDATE，並把 `edge-insert`
   patch 改成**帶版本護欄的 upsert**（原本只在「不存在時」新增，UPDATE 到
   了也是 no-op）。

## 具名在場（誰在這塊板）

既有 presence 只回人頭數（`Object.keys(presenceState()).length`）。現在
track 的 payload 帶 `{ name, boardId }`，`onPresenceList` 回具名名單，
白板頂列顯示「N 在板上」並在 title 列出名字。

**刻意不做游標流**：沿用 `presence.ts` 既有的「行動裝置友善」紀律 —
只在**開/關板**時 retrack，不送 16ms 心跳、不送座標。誰在編輯哪個節點
仍由節點上的 `lastWriterId/Name` 戳記推導（30 秒視窗）。

## 版本歷史（0025 從有表到可用）

- `listBoardVersions`（新）＋既有 `createBoardVersion`。
- `versions.ts` 純函式層：`buildSnapshot`（墓碑不入快照）、`planRestore`、
  `describeRestore`。
- **還原不是整包覆蓋**（ADR-014）：算出 upsert／軟刪清單，逐筆走既有節點
  管線 — OCC、op 帳、離線佇列全部沿用。關鍵細節：套用時**沿用現況的
  version**，直接把快照那列寫回去會帶著舊 version、必被 OCC 永久擋下
  （409 死迴圈）。這條有反例測試。
- UI 在「更多 → 版本歷史」：存快照、列出快照（每張標註「還原會發生什麼」
  的人話摘要）、點擊還原。雲端房才顯示入口（本機房沒有快照表 — 誠實不擺
  按不動的按鈕）。

## History 協調器硬化（WB03 誠實記錄的兩條）

改用**每格 history 帶序號**取代「數 pop 次數」：
- **forward 幽靈格**（S18）：按瀏覽器「下一頁」會落在序號更大的舊格，
  計數式一律當 back → 把白板關掉。序號式一眼看出是前進，不派發。
- **亂序關層**（S18）：中段層被程式性關掉時它那格移不掉；序號式把它當
  普通舊格跳過，`zombie` 旗標整個拿掉。
- **長按返回跨多格**：由上而下逐層關，不留孤兒。
- 仍未根治（誠實）：使用者的 back **正在途中**時同時發生程式性關層，
  兩格會被一起消耗。要根治得能問「這個 popstate 是誰觸發的」，瀏覽器
  不提供。競態窗只有一次 traversal。

## e2e mock 的忠實度

`order`/`limit` 原本被靜默忽略 — 版本清單「最新在前」若只在 mock 裡
自動成立，排序壞掉也測不出來。現在 mock 真的照做。
（同一類假綠：WB03 的 `whiteboard_frames` 缺自然鍵讓 frame 更新全程假綠。）

## 兩條「做了但還不完整」的誠實記錄

- **edge UPDATE 訂閱目前是死碼**：客戶端沒有任何修改既有 edge 的寫入路徑
  （建立時 label 是空字串，UI 沒有編輯線標籤的入口）。訂閱與 upsert 版本
  護欄是為了「別的客戶端/未來版本改了線」而先備好的收斂規則，單元測試驗的
  是合併規則本身、不是功能。線標籤編輯屬後續。
- **本機房（無 Supabase）的 frames 只活在 React state**：關板再開就沒了，
  第一次分享上雲也不會被搬過去。0023 是雲端表，本機房沒有對應的
  IndexedDB 結構。版本歷史入口在本機房已誠實隱藏（handler 不掛），frames
  的本機持久化未做 — 要嘛補 IndexedDB schema，要嘛在本機房也隱藏建立區塊
  的入口，兩者都比「假裝存住了」誠實，留給下一輪決定。

## 不做（誠實邊界）

- **游標／選取範圍的即時廣播**：與行動裝置優先的紀律衝突，且需要
  broadcast channel 與節流層 — 平板/Pencil 輪（WB05）再評估。
- **欄位級三方合併**：目前是「有未存編輯就不被覆蓋」＋OCC＋drift 防護。
  真正的文字合併需要 CRDT 或 OT，ADR-014 已明確排除本階段導入。
- **operations 活動流 UI**（誰改了什麼的時間軸）：0024 的資料在，
  UI 屬 WB06 的稽核面板。
- 非白板的表仍是「自己的寫入回彈成整房 reload」— 既有行為，未觸碰。
