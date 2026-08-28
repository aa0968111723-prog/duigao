# WB02 Grok 對抗審查 — Claude 逐項裁決

- 輪次：wb02（Focus Mode／手勢仲裁／undo-redo／視覺回歸）
- Grok verdict：**MUST_FIX**（9 findings，6 blocking）
- Claude 裁決：**9/9 接受**（0 反駁）。全部修復或誠實文件化，逐項如下。
- 原始 findings：`grok-findings.json`（同目錄）

## F1 [high] pinch 縮放指數失控 — 接受，已修

Grok 抓到 reducer 的 `scale` 是「相對起手距離的絕對比」，但呼叫端把它
乘在**當下** `camera.zoom` 上 — 兩指各動一次就連乘兩次，縮放指數失控。
確認屬實：是我重寫 reducer 時把起手基準弄丟（舊實作的 `pinch.zoom`
留了欄位沒用上）。

修法：改「增量比」語意 — `scale = distance / pinch.distance`，且每次
move 後 `pinch.distance = distance`。乘法鏈 `zoom × s1 × s2 × …` 收斂
於總距離比。反例測試：距離不變的第二次 move 必須回報 `scale=1`
（舊實作回報 2 → 測試紅）。

## F2 [high] 節點上的雙擊死路＋單元測試假綠 — 接受，已修

`begin-drag` 回填把 `mode=drag`、`dragLast` 非 null，up 的 tap 條件
`sameGPoint(next.dragLast, null)` 永遠 false — 節點上的雙擊（進編輯的
唯一手勢入口）到不了。原「缺陷4」單元測試沒餵 `begin-drag`，走的是
空白處路徑，所以假綠。全部屬實。

修法：tap 判定改為「up 時長按仍 armed」（＝位移未超過 slop 且未逾時），
與 mode 無關；`sameGPoint` 移除。新增反例測試：餵完整
down→begin-drag→up 路徑斷言 double-tap；再斷言真的拖過 slop 不誤發 tap。
副作用防護：commit-drag 現在過濾「實際位移過」的節點，tap 不再觸發
空寫入。

## F3 [high] endEdit 副作用進 setState updater — 接受，已修

`record()/nextOpId()/onEmitOperation` 放在 `setEditingId` 的 updater 裡；
React StrictMode（main.tsx 有開）雙呼 updater 驗證純度 → 一次編輯
session 入兩筆相同 undo、發兩個 op。屬實。

修法：新增 `editingIdRef`（隨 begin/endEdit 同步更新），record 移到
事件處理器本體，updater 恢復純函式。

## F4 [high] 拖曳放手跳回起點＋增量疊舊基準 — 接受，已修

兩half都屬實：(a) `move-nodes` 用 render 閉包的 `previewNodes` 當基準，
同一批 pointermove 之間沒 re-render，增量疊在過期基準上；(b) commit
先清 preview、`persistNodes` 還 debounce 120ms，這 120ms 內房態沒更新
→ 節點跳回起點再彈回。

修法：`previewRef` 作拖曳期間的同步事實來源（move 讀寫 ref，state 只供
render）；commit 改直接 `api.onUpsertNodes(movedNodes)` — App 的樂觀
更新是同步的，同 handler 內清 preview 不閃。120ms debounce 的
`persistNodes` 與 `DRAG_PERSIST_MS` import 一併移除。

## F5 [medium] history 階梯三個 race — 接受，已修

(a) 連續兩次 back：`sheetRef` 靠 render 期賦值同步，兩次 popstate 夾在
re-render 之間會讀到舊值 → sheet 被「關兩次」、板誤退。修法：`setSheet`
包一層 wrapper，ref 隨 setter **同步**更新。
(b) effect 鍵 `board?.id`：切板時 cleanup 的 `history.back()` 是非同步，
會打進新 effect 已掛上的 listener → 誤 `onOpenBoard(null)` 關掉剛開的板。
修法：effect 只鍵 `focused`，切板期間 history 層原地保留。
(c) UI 返回鈕直呼 `onOpenBoard(null)`，靠 cleanup 補償 back — 與 pop
路徑記帳不一致。修法：返回鈕改 `history.back()`，單一退出路徑；
`pushedRef` 記帳（已被 pop 消耗就不補 back），非 back 路徑（封存板）
仍由 cleanup 清層。

## F6 [high] 鍵盤避讓 deps 殘缺＋Android resize 模式失效 — 接受，已修

deps 只有 `[editingId, keyboardInset]`，camera/viewport/liveNodes 被
eslint-disable 排除 — inset 不變時使用者亂平移後不再修正；Android 鍵盤
是 resize 模式（`innerHeight` 跟著縮 → inset≈0），整個避讓從未生效。
屬實。

修法：full deps `[editingId, keyboardInset, camera, viewport, liveNodes]`
— Android 靠 ResizeObserver 餵縮小後的 `viewport.height` 觸發重算
（`limit = viewport.height - inset - 72` 兩平台通用）；位移後條件收斂
（`screenBottom == limit`）不迴圈。真機驗證仍列 real-device-checklist
第 5 項（headless 縮不了 visualViewport — 誠實邊界不變）。

## F7 [medium] e2e 面積斷言可被 overlay 假綠 — 接受，已修

斷言只量 `wb-canvas` 元素矩形 — 若日後工具列改 absolute 疊在 canvas 上，
canvas 變大、數字更好看但可用面積反而縮。修法：canvas 面積扣掉
`.wb-focus-top/.wb-focus-bottom/.wb-editing-line` 與 canvas 的矩形交集
（現在交集 0；改 overlay 會誠實掉下去）。視覺基準的決定性批評
（uuid/board id 不入圖）：截圖不含 id 文字，12 張已驗 rerun diff=0，
維持現狀。

## F8 [medium] 文字 undo 靜默蓋掉並發修改 — 接受，已修（藥效範圍誠實）

逐鍵 `onUpsertNode("now")` 即時寫、op 只在 session end 記一筆 —
undo 用 applyMasked＋當下 acked version 走 OCC，version 是新的所以
**OCC 擋不住**「期間別人改了同欄位」的情況，會靜默蓋字。屬實。

修法（mitigation，非完整方案）：history 執行端加 drift 防護 — undo/redo
套用前逐 mask 欄位比對「現值 == 這步 op 產出的值」，不符回
`conflict-drift` 誠實跳過＋畫面提示（`wb-notice`），寧可不動也不蓋別人
的字。反例測試：同事改過 content.text 後 undo → skipped、store 不變。
完整的欄位級三方 merge 屬 WB04（realtime 輪）範圍。

## F9 [medium] keep-mounted 沒做卻寫在 wireflow — 接受，文件誠實化

wireflow 寫「切對話 tab display:none 不 unmount」；實際 tab 切換走
`onOpenWhiteboard(null)` → unmount → camera 重置。不實作的原因：tab
語意在 App 層，keep-mounted 需要容器改構，超出 PR-02 最小侵入邊界。
處置：wireflow 偏差附錄新增第 7 條（行為＝「切對話＝關板」），
keep-mounted＋re-measure 排 WB03；`.wb-shell`/`.wb-toolbar`/
`.wb-canvas-wrap`/`.wb-bottom` 死 CSS 已刪。

## 視覺基準重切（F2/F4 的可見證據）

修復後視覺回歸 3 張 `-selected`（412/768/1024）掉紅 — 檢視 diff 發現
**舊基準裡烙著 bug 痕跡**：修復前點選節點的 tap 會誤觸 commit-drag，
把全部 20 個節點無差別重寫（無位移過濾）走 120ms debounce，偶發 409
→「這個節點被別人改過…」衝突 toast 被拍進基準（390 因時序逃過）。
修復後假寫入消失、畫面乾淨，判定**新圖才是對的** — 以 UPDATE_VISUAL=1
重切基準並重跑兩次確認 diff=0（決定性保持）。

## 修復後驗證

- `tsc --noEmit` 乾淨；gesture/order/history/registry 單元 11/11
  （含 F1/F2/F8 三條新反例 — 各自在舊實作上會紅）。
- 全 e2e 矩陣與視覺回歸重跑結果見 PR 描述（§30 報告）。
