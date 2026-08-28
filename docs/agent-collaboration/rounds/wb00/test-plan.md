# 白板重構測試計畫（PR-01 起逐階段落地）

原則：沿既有 harness（tsx --test unit＋Playwright×mock-supabase e2e＋
migrations.mjs 真 PG 五角色探針）；新增視覺回歸與真機清單。每個 PR 的
完成標準見任務書 §29 — 本文件列「新增哪些」。

## PR-01（schema/operations/anchors）

- migrations.mjs 新章：0021–0024 五角色 CRUD 矩陣、edges stale-write、
  frames 複合 FK、operations append-only＋actor 冒名、versions 不可變、
  soft-delete 經 OCC、冪等重跑 shape 比對、link_pair 約束。
- unit：operation payload 逆操作 round-trip；tombstone 讀側過濾；
  anchor 新臂（message/plan-section）adapter round-trip（契約層 26 條
  基礎上擴充）；edge version client mirror。
- 負向控制：reviewer 寫 operations 403、anon 全拒、z_index/rotation
  超界 CHECK 擋下。

## PR-02（手機 Focus Mode）

- unit：手勢仲裁狀態機（pinch 起手清 drag、slop 內長按存活、slop 外
  取消、雙指位移→camera、pointer 雙擊窗口）；registry（node 型別→
  renderer 對映完整、未知型別 fallback）；工具列三態 reducer。
- e2e（collaboration-workspace.mjs 擴充＋新 focus-mode 章）：
  進出 Focus Mode（back 手勢層）、畫布面積斷言（`wb-canvas-wrap`
  rect ≥ 視窗 75%）、FAB 在 Focus Mode 不存在、拖節點/雙指縮放平移
  （CDP touch 合成）、長按選單、框選/套索多選、鍵盤避讓（focus 節點
  可見斷言）、undo/redo。
- 視覺回歸（新 `test:visual` 套件，Playwright screenshot 比對，
  容差 maxDiffPixelRatio 0.01）：390×844、412×915、768×1024、
  1024×1366 × light/dark = 8 基準圖（空板/20 節點/選取態）。

## PR-03（雙向連結）

- integration：訊息→node（provenance：linkedEntityType='discussion'＋
  可回跳原訊息）、node→訊息（既有閉環回歸）、poster region 錨、video
  時間碼錨（跳轉正確秒數）、plan section 錨、來源刪除→unavailable
  state（不炸、誠實文案）、無權限來源→同左。
- Universal Intake：每個入口建 metadata→選落點的分流各一條 e2e。

## PR-04（Realtime/presence）

- e2e 雙分頁：cursor presence 顯示與 throttle（80ms 內合併）、
  selection presence、編輯中標記、離線→重連 →佇列重放恰一次（既有
  離線矩陣擴充 operations 重放）、衝突可見（雙端同節點改→一端誠實
  drop+refetch）、版本歷史（快照建立/瀏覽/還原→bulk-restore op）。
- 效能（新 `test:board-perf`，非 CI gate、輸出量測報告）：100/500/
  1000 節點＋2000 邊 headless 量 render commit 時間與 fps proxy、
  culling 生效斷言（DOM 節點數 << 資料節點數）、拖曳中零 DB 寫入。

## PR-05（平板）／PR-06（AI）

- 平板：Split View e2e（768/1024 兩檔）、Pencil pointerType='pen' 路徑
  unit、鍵盤快捷鍵矩陣。
- AI：proposal→preview→apply→audit 全鏈 e2e（含 Cancel/Reject/Undo/
  失敗態）、apply 前自動快照、mock adapter 型別測試（不宣稱真連線）。

## 真機 smoke（每個 UI PR 附錄影/截圖）

優先序：Android Chrome → LINE Browser → iPhone Safari → Android
tablet → iPad → desktop。腳本：開房→開板→建 3 節點→拖/縮/平移→
長按多選→連線→離開回討論→回板（狀態保留）。
量測項：ADR-013 重評檢查點的五項數字。

## 迴歸保護

- 每 PR 全綠既有 8 套件（含 test:edge-cors）；
- 白板 e2e 的 stale-write/離線矩陣為不可刪保護線（任務紀律：不得刪
  測試、不得放寬斷言換綠）。
