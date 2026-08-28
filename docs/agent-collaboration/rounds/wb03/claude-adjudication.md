# WB03 對抗審查 — Claude 逐項裁決

兩路獨立審查：

1. **Claude 自審 workflow**（5 面向找缺陷 → 每條由「預設反駁」的懷疑者
   驗證）：20 條 findings。其中 gesture-pointer 面向 5 條完成對抗驗證
   （**0 條被反駁**）；其餘面向的驗證者在跑到一半時因帳戶月度支出上限
   中斷（16 個 agent 失敗）— **未驗證的部分由我自己逐條查證原始碼**，
   下方每條都附我實際跑出來的證據。
2. **Grok 對抗輪**：verdict **MUST_FIX**，4 條 findings。其中 3 條與自審
   重疊（獨立雙重確認），1 條（雲端冷啟動）自審也有、兩邊都判 high。

裁決：**全部接受、全部修復**，0 條反駁。原始資料：
`grok-findings.json`、`self-review-findings.json`。

## 已修（自審 gesture 面向，5 條全部通過對抗驗證）

**S1 [high] 繪圖轉 pinch 用起筆點當基準 → 起手暴縮**
第一指畫了 300px 後第二指落下，回放給 reducer 的是 `strokeDownRef` 的
**原始**落點，pinch 基準距離因此錯了整個筆畫長度；下一個 move 用真實位置
重算，`scale = 實際距離/過期距離` 讓畫面猛然縮放＋大幅平移。修：追蹤第一指
**當前**螢幕座標（`strokeScreenRef`）作回放基準。

**S2 [medium] pinch 回放洩漏 hit-test 副作用**
回放的 down 走完整單指命中邏輯 → 起筆點壓在節點上就選取它、在空白處就清空
既有選取，使用者只是縮放卻改了選取態。修：回放**不經 runEffects**（只重建
pointers map，丟棄 effects）。

**S3 [medium] frame 拖曳 session 無 pointerId 記帳**
兩指分別按兩個 frame 把手會互相覆寫 session，frame 以錯誤基準亂跳並以錯誤
幾何入帳 undo。修：session 記 `pointerId`，move/up 驗證來源；已有 session
時第二指不覆寫（先到先贏）。

**S4 [medium] 繪圖模式下 frame 把手仍攔截**
每個 frame 頂部 30px 全寬帶 `pointer-events:auto` 且 `stopPropagation`，
繪圖時筆畫起點落在那裡會變成拖 frame（還留一筆 undo）；frame 越多可畫區
破洞越多。修：`drawMode` 時把手不攔截（讓事件冒泡回畫布）。

**S5 [low] 唯讀者在 frame 標題帶上是拖動死區**
`beginFrameDrag` 無條件 `stopPropagation`，唯讀者 move 又因 `!canEdit`
提前 return — 畫布不平移、frame 也不動，放手還誤觸選取。修：`!canEdit`
時不攔截（WB02 時該處本來可平移，是本輪新引入的退步）。

## 已修（我自行查證的其餘面向）

**S15 [high] 對稿 overlay 被白板 Focus 整個蓋住 — 旗艦流程實際不可用**
`.project-workspace-overlay` z-index **40** < `--z-board-focus` **45**：板上
「打開內容」開出的對稿在不透明的 Focus 之下，畫面零變化，而 back 卻先關掉
那層看不見的 overlay（要按兩次返回才有可見效果）。**我原本的 e2e 只斷言兩者
同時存在於 DOM — 正是假綠**。修：overlay 提到 z=50（仍低於 scrim 80），
z 階梯註解同步；e2e 改用 `elementFromPoint` 驗畫面中央真的命中 overlay。

**S8 [high] 節點 create/delete draft 丟失 nodeType/尺寸 → undo 造成資料損毀**
`nodeCreateDraft`/`nodeDeleteDraft` 用「同一節點但 content 清空、x/y 設 NaN」
當 before 做 diff，於是 nodeType/width/height 與自己相同、永遠不進 mask。
我實測 freehand 節點：`mask = ["x","y","content.points"]`。刪除後 undo 走
recreate（空白 text 基底＋applyMasked）→ 筆畫復活成 180×96 的空白便利貼，
**還會寫回雲端**。frame 側當初用 `FRAME_CREATE_FIELDS` 全集避開了同一坑，
node 側沒補。修：改為 `snapshotMask()` 全欄位快照。
附帶：WB02 那條「delete 的 undo 必須重建節點」測試的 recreate harness 直接
`node(id)` 忽略 draft — **假綠**，已改成與真實執行端同構。

**S6 [high] frame 寫入無版本簿記 → 第二次寫入永遠 stale、重試佇列中毒**
0023 的 touch trigger 會 bump version，但 `upsertFrame` 以
`.then(() => undefined)` 丟棄回傳、App 端版本永遠停在 1 → 同一板第二次
拖曳/改名必被 stale-write 拒絕；且 `run()` 的重試 closure 捕捉同一份過期
payload，重放永遠失敗。修：送出前查 latest（重試自動用已 ack 的版本）、
ack 後回報 persisted 版本給 App 採納。

**S9 [medium] e2e mock 讓 frame 持久化全程假綠**
`whiteboard_frames` 不在 mock 的 `CONFLICT_KEYS` → 更新走 insert → 409
duplicate → 被 client 折成成功，mock 資料列從未改變；mock 也沒有 frames 的
版本 OCC。**S6 那個 high 級 bug 因此測不出來**。修：補自然鍵與 OCC，e2e
新增「連續兩次拖曳都生效 ＋ mock 列 version ≥ 2」的斷言。

**S10/Grok-F1 [high] 雲端冷啟動時反向鏈 chip 整個消失**
`loadCollaborationSummary` 刻意回 `nodes: []`（節點只在開該板時才載），而
chip 只掃房內已載入節點 → 重整後沒開過白板就打開對稿，「⊞ 白板 N」不存在，
本輪主打功能在冷啟動路徑上等於不存在（e2e 因為先「加入白板」才開對稿而
看不到）。修：新增輕量查詢 `loadNodeRefs`（只取 id/whiteboard_id），與本機
節點以 node id 合併去重。

**S13/Grok-F2 [high] 反向鏈 chip 繞過開板路徑 → 目標板 frames 全不見**
`open()` 直接 `setActiveWhiteboardId`，不像 `onOpenWhiteboard` 會清空並重載
frames → 板開了、節點都在，但區塊不渲染（boardFrames 還是上一塊板的），
使用者以為區塊被刪了。修：抽出 `loadFramesForBoard` 共用同一條路徑。

**S14/Grok-F4 [high] focusNodeId 每次節點變動就搶相機與選取**
effect deps 含 `nodes`/`viewport` 且無記帳，`focusNodeId` 只在關板才清 —
經反向鏈或討論連結進板後，**每打一個字**（`onUpsertNode("now")` 換掉 nodes
identity）相機就被拉回舊焦點、選取被搶走，與 camera memory 和鍵盤避讓直接
打架。修：每個 focusNodeId 只套一次（`appliedFocusRef`），節點未載入時不
記帳、下次再試。

**S12/Grok-F3 [high] Escape 雙重處理：一次按鍵關掉兩層**
overlay 疊在 Focus 上時兩個 listener 都在（MBR 的 `document` keydown 直呼
`onBackToRoom`，WW 的 `window` keydown 直呼 `history.back()`），互不知情各關
一件，常見排程下 overlay 與白板一起被關。修：Escape 改由 historyLayers
獨佔派發（`handleEscape()` 只打棧頂、`closed` 才消耗一格 history），WW 撤掉
自己的 listener、MBR 只留 pushedPane。

**S7 [high] 巨筆畫的 2000 夾限有 1-ulp 浮點外溢**
`rawW * (2000/rawW)` 可能得 `2000.0000000000002`，DB CHECK 是 `<= 2000` →
永久 400，失敗寫入還進 IndexedDB 重試佇列反覆重放。**我原本的單元測試用
6000×3000 恰好整除 → 假綠**。修：clamp 移到乘回之後。

**S11 [low] 反向鏈 chip 把封存板的節點也算進去** → 點進去落到空白板的死路。
修：只算未封存板上的節點。

**S17 [low] StrictMode 讓 camera memory 在還原當下被預設值覆寫**
create→destroy→create 中，destroy 存的是還沒 re-render 的 `cameraRef`
（仍是初始值），把剛還原的視角**實際銷毀**，dev 環境永遠驗收不到。
修：還原時同步寫 `cameraRef.current`。

## 已修（追 e2e 紅燈追出來的既有資料遺失）

**P1 [high] 打字中的企劃段落被回音整批洗掉**
`emptyPlan()` 用 `Date.now()` 當「還沒存過」的 placeholder 時戳，而
PlanEditor 的護欄是「遠端比本地新才接受」→ `room.plans` 每換一次身分就生出
一份「更新的」空企劃，把使用者正在打、還沒按完成的段落洗掉。更嚴重的是
建立企劃分支時伺服器存的空企劃**必然**比草稿新，只要那份回音在打字之後
落地就必中。修：placeholder 時戳改 0，並加入「有未存編輯就不接受任何遠端」
的髒標記語意（存檔後落旗）；護欄抽成純函式 `planDraft.ts` 附反例測試。

**這條的教訓值得記下來**：它原本被我判成「共機埠覆寫的環境不相容」（wb02
基準在同一條件下也紅，我拿這當「非回歸」的證據）。但「非本輪引入」不等於
「不是 bug」— 換環境才紅通常只是時序把真 bug 遮住了。修復後同條件連跑
5 次：4×54/54、1×52/54（那次是另一支影片檢查，在別的代理 e2e 併跑時），
企劃段落消失 0/5 復發（修復前約 50%）。

## 未修，誠實記錄

- **S18 [low] forward 幽靈格**：同一批次「移除棧頂＋push 新層」會留下
  forward 記錄，按瀏覽器「下一頁」會關掉白板。協調器把所有非
  pendingConsume 的 popstate 一律當 back，無法分辨 forward。
- **S19 [low] 使用者 back 在途時程式性關層**：`pendingConsume` 只做計數、
  無法辨識在途 pop 的來源，窄競態下可能多退一格。
  兩條都需要 history state 帶序號才能根治，屬 WB04 的 history 硬化範圍。
- **影片分支 e2e 在機器高負載下偶發紅**（5 次跑 1 次）：`videoUploadDelayMs`
  故障注入＋90s 等待，另一代理 e2e 併跑時逾時。未觸碰、非本輪引入，
  記錄機制而不宣稱已修。

## 修復後驗證

tsc 乾淨；單元 195（collab 129 含 S8/S12/P1 反例、multi-branch 25、
asset 15、viewer 5、agent 16、edge-cors 5）；migrations **288/288**；
collab e2e **76/76**（含 S15 可見性、S6 版本、S14 焦點、S1/S2 轉 pinch
四組新反例）；multi-branch **54/54**；asset-intelligence 12 PASS；
視覺 **12/12** 決定性；build 綠。
