# Claude 裁決 — PR-08a（bundle code-split）Grok round

日期：2026-08-28 ｜ 分支：feat/bundle-code-split ｜ Grok verdict MUST_FIX（F1–F4 全 blocking）

## 總表

| # | Grok 判定 | 裁決 | 處置 |
|---|---|---|---|
| F1 | root Suspense fallback=null 讓進房把整棵樹（含 Home）換成白屏 | **接受** | root 邊界撤掉；掛載點就地 `RoomWorkspaceShell`/`MultiBranchRoomShell`（fallback=既有 onboard 載入卡） |
| F2 | chunk 載入失敗（離線 PWA / 新部署撤 hash）→ 永久白屏無敘事 | **接受** | `lazyShell` catch → `ChunkLoadError` 卡（說人話＋重新整理鈕；重整拿新 index 必指向存在的 chunk） |
| F3 | open() async 化後 stopped 擋不住重入：雙 openWith 疊加、舊 catch 亂寫 status | **接受** | `openSeq` 世代守衛：open() 取號、teardownPeer 作廢 in-flight、then/catch 均驗 `seq===openSeq` |
| F4 | e2e heal 等待可被 02b 舊 GET 立即滿足；逾時不紅 | **接受（兩段修正）** | 先改「基線後新 GET 必發生」— 立刻被自己的斷言抓到 heal 是 0-or-1 競態（subscribe 完成早於開板就沒有 heal GET）。終版：量測窗前「板 GET 計數穩定 1.5 秒」靜默錨點，逾時（GET 迴圈）即紅 |

## F4 的插曲（誠實記錄）

第一版修正把「heal 必發生」寫成斷言，第一次執行就紅 — 證明 heal GET
在此流程是合法的 0-or-1（B 的 channel SUBSCRIBED 早於開板 →
activeWhiteboardRef 尚空 → 無 heal；晚於開板 → 一次 heal）。「必發生」
與「必不發生」都是錯的斷言；靜默錨點才是對競態誠實的寫法，且保留
「GET 迴圈 = 紅」的偵測力。

## 量測

| | before | after |
|---|---|---|
| 進場 JS（Home 首屏） | 902KB（單塊） | 404KB index＋12KB react |
| 隨需 | — | RoomWorkspace 129KB＋CSS 26KB、MultiBranchRoom 50KB、peerjs 89KB |
| vendor 快取塊 | — | supabase 220KB（部署間 hash 穩定） |

## 回歸

collab 35/35（新靜默檢查）、multi-branch 21/21（隔離）、video 165/165、
share 72/72、review-viewer 27/27、share-preview 176/176、unit 全綠、
gate PASS。組合負載下 multi-branch 的 plan-editor 30s wait 逾時一次 —
既有機器負載 flake 家族（task chip 追蹤中），隔離與 CI 皆綠。

## 結論

F1–F4 全數落實（F4 以更誠實的錨點超額完成）。可 PR / merge gate。
