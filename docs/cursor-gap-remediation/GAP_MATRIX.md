# GAP_MATRIX

Base: `origin/main` @ `398960d`  
Production probe: 2026-08-29 against https://duigao-k7q2.zeabur.app/  
Status: `OPEN` / `FIXED_THIS_PR` / `PAUSED_OWNED_ELSEWHERE` / `BLOCKED` / `PHYSICAL_DEVICE_PENDING`

Every row is grounded in source, HTTP, GitHub, or a test. TODOs alone are not defects.

---

## GAP-00-001

| Field | Value |
|---|---|
| ID | GAP-00-001 |
| 領域 | production / HTTP honesty |
| 問題 | Zeabur SPA catch-all 對 `/functions/v1/*`、`/rest/v1/*`、`/api/*` 回 **HTTP 200 + text/html（index.html）**。只看 `response.ok` 會當成後端成功。 |
| 重現步驟 | `curl -sI https://duigao-k7q2.zeabur.app/functions/v1/voice-token` → 200 `text/html`. Body starts `<!doctype html>`. Same for `/rest/v1/rooms`, `/api/health`. |
| 預期行為 | 這些路徑若打在 **app origin** 不得被當成 edge/REST 成功；client 必須拒絕 HTML。真 API 只在 Supabase origin。 |
| 實際行為 | App origin 全是 SPA 200。supabase-js 打 `uanurolzzgshxrqbooix.supabase.co` 時不受這條 rewrite 影響；**任何誤打同 origin 的 fetch 都會假成功。** |
| 裝置 | all (server rewrite) |
| 嚴重度 | P0 |
| 影響 | 語音 / Canva / CUTOS / REST 若誤用 app origin，會顯示已連線或上傳成功。 |
| 根因 | `vercel.json` `/(.*)` → `index.html`；Zeabur/Caddy 同等 SPA fallback。 |
| 相關檔案 | `vercel.json`, `src/cloud/apiResponse.ts`, `src/cloud/voiceToken.ts`, `src/cloud/canva.ts`, `src/cloud/cutos.ts` |
| 相關資料表 | none |
| 相關 PR | this PR-GAP-00 |
| 是否可立即修 | client 拒絕：是（本 PR）。拿掉 SPA rewrite：否（會弄壞 client route）。 |
| 需要的測試 | `scripts/tests/api-response.test.ts`（正例／HTML 負例／status-only 對照／mutation） |
| 修復分支 | `cursor/gap-remediation-audit-70d9` |
| 狀態 | FIXED_THIS_PR（client）。Infra rewrite 保留，屬預期 SPA 行為。 |

---

## GAP-00-002

| Field | Value |
|---|---|
| ID | GAP-00-002 |
| 領域 | voice / Canva / CUTOS payload |
| 問題 | `functions.invoke` 成功路徑把 `data` 直接當 payload。`{ ok: true }` 缺 `url`/`token`/`versionId` 仍可能往下走。 |
| 重現步驟 | 對 `fetchVoiceToken` 餵 `{ ok: true }`（無 url/token）。舊碼 `as VoiceTokenResult` 後 `if (!tokenResult.ok)` 為 false，接著 `connectVoice({ url: undefined, token: undefined })`。 |
| 預期行為 | `ok: true` 必須帶齊契約欄位，否則當失敗，不連線、不顯示匯入成功。 |
| 實際行為 | main 上 voice token / Canva import / CUTOS import 缺少欄位守衛。 |
| 裝置 | all |
| 嚴重度 | P0 |
| 影響 | 假連線、假匯入成功。 |
| 根因 | 型別斷言代替執行期檢查。 |
| 相關檔案 | `src/cloud/voiceToken.ts`, `src/cloud/canva.ts`, `src/cloud/cutos.ts`, `src/cloud/apiResponse.ts` |
| 相關資料表 | none |
| 相關 PR | this |
| 是否可立即修 | 是（unowned clients） |
| 需要的測試 | `parseFunctionPayload` MISSING_KEYS 負例 |
| 修復分支 | `cursor/gap-remediation-audit-70d9` |
| 狀態 | FIXED_THIS_PR |

---

## GAP-00-003

| Field | Value |
|---|---|
| ID | GAP-00-003 |
| 領域 | voice copy |
| 問題 | 未設定 LiveKit 時討論列寫「語音房間還在準備，這一版先把討論和白板做好。」任務書要求「語音服務尚未設定」。 |
| 重現步驟 | 開雲端房 → 討論列 `data-testid=voice-boundary`。Production bundle 同時含兩句（`useVoiceRoom` 已有「語音服務尚未設定。」，`voiceUnavailableReason()` 仍是舊句）。 |
| 預期行為 | 無 provider 時顯示「語音服務尚未設定」，不暗示功能即將可用、不假裝有人在場。 |
| 實際行為 | 邊界列用舊文案。 |
| 裝置 | phone / tablet / desktop |
| 嚴重度 | P1（誠實狀態；非資料遺失）— 列在 P0 語音批次因為與 truthful state 同一條產品紅線 |
| 影響 | 使用者以為語音「快好了」而不是「沒設定」。 |
| 根因 | `src/features/collaboration/voice.ts` `voiceUnavailableReason`。 |
| 相關檔案 | `src/features/collaboration/voice.ts`（UI 呼叫在 `RoomDiscussion.tsx`，該檔屬 #95，本 PR 不改） |
| 相關資料表 | `voice_sessions` (0014) |
| 相關 PR | #64/#65 voice MVP; #95 owns discussion shell |
| 是否可立即修 | 是（改 reason 函式即可，e2e 只 assert 含「語音」） |
| 需要的測試 | `api-response.test.ts` 字串契約 |
| 修復分支 | `cursor/gap-remediation-audit-70d9` |
| 狀態 | FIXED_THIS_PR |

---

## GAP-00-004

| Field | Value |
|---|---|
| ID | GAP-00-004 |
| 領域 | migrations / release |
| 問題 | 三條開著的 PR 與 main 的 0022 **編號互撞**。#95 還改已落地的 `0006`。 |
| 重現步驟 | 列出 `origin/main` migrations（head 0022_discussion_author_integrity）。對照 #78 files（0022–0026 whiteboard）與 #95（0023_video_optimize + 0006 edit）與 #88（0027–0028）。 |
| 預期行為 | 開 PR 前先看 main head 再鑄下一號；不改已套用檔。 |
| 實際行為 | #78 base 停在 `361bec0`；#88 body 仍寫「main 到 0021」。 |
| 裝置 | n/a |
| 嚴重度 | P0（若人類亂合併會弄壞 production migration history） |
| 影響 | 合併後 gate 紅、或正式庫 history mismatch。 |
| 根因 | 各線從不同 main 各取 +1；gate 禁止留洞。 |
| 相關檔案 | `supabase/migrations/*`, `docs/cursor-gap-remediation/MIGRATION_RESERVATION.md` |
| 相關資料表 | many |
| 相關 PR | #78 #88 #95 #94 |
| 是否可立即修 | **否** — 要人類 rebase 別人的 PR。本線不鑄號。 |
| 需要的測試 | `npm run test:migrations` on each rebased PR |
| 修復分支 | owners’ branches, not ours |
| 狀態 | BLOCKED（human rebase） |

---

## GAP-00-005

| Field | Value |
|---|---|
| ID | GAP-00-005 |
| 領域 | files / outbox / discussion |
| 問題 | 上傳路徑、outbox 持久化、討論殼深化與 #95 檔案重疊。 |
| 重現步驟 | `gh pr view 95 --json files` 含 `RoomDiscussion.tsx`, `useDiscussionOutbox.ts`, `videoAssets.ts`, `App.tsx`。 |
| 預期行為 | 不重做開著 PR 已擁有的功能。 |
| 實際行為 | 若本線再改同一批檔會雙寫。 |
| 裝置 | all |
| 嚴重度 | P1 |
| 影響 | 合併衝突、行為分叉。 |
| 根因 | 並行 agent。 |
| 相關檔案 | see FILE_OWNERSHIP |
| 相關資料表 | `room_discussion_messages`, storage |
| 相關 PR | #95 |
| 是否可立即修 | 否 |
| 需要的測試 | #95 既有 video/outbox |
| 修復分支 | wait for #95 |
| 狀態 | PAUSED_OWNED_ELSEWHERE |

---

## GAP-00-006

| Field | Value |
|---|---|
| ID | GAP-00-006 |
| 領域 | whiteboard |
| 問題 | Canonical schema / tombstone / operations 只在 #78。main 仍是 0014 節點模型。 |
| 重現步驟 | `gh pr view 78` state=open, merged=false, mergeable_state=dirty。 |
| 預期行為 | 暫停白板批次直到 #78 合併或明確 stack。 |
| 實際行為 | #78 未合併。 |
| 裝置 | all |
| 嚴重度 | P1 |
| 影響 | 開板協作仍是 0014 + row-patch（已合併的 PR-02c），沒有 0023 operations。 |
| 根因 | 未合併。 |
| 相關檔案 | `src/features/whiteboard/**`, `collaborationRepository.ts` |
| 相關資料表 | `whiteboard_nodes` (0014) |
| 相關 PR | #78 |
| 是否可立即修 | 否 |
| 需要的測試 | #78 migrations 281 探針（其 PR 自稱；本 session 未重跑該分支） |
| 修復分支 | #78 |
| 狀態 | PAUSED_OWNED_ELSEWHERE |

---

## GAP-00-007

| Field | Value |
|---|---|
| ID | GAP-00-007 |
| 領域 | Design Intelligence / external AI |
| 問題 | DI 完整交付在 #88；main 只有 `design-intelligence-schema.test.ts`。Canva 真 OAuth 需 edge secret，本環境沒有。 |
| 重現步驟 | `gh pr view 88` open. main `src/features/design-intelligence/` 存在契約檔，完整引擎在 #88。 |
| 預期行為 | 未設定顯示「整合尚未設定」；AI 不得當成員確認決策。 |
| 實際行為 | App 對 Canva/CUTOS 已有誠實字串（bundle 含「Canva 整合尚未設定」「CUTOS 整合尚未設定」）。DI apply 完整鏈在 #88。 |
| 裝置 | all |
| 嚴重度 | P1 |
| 影響 | 研究層 / 知識表未在 production schema（未證）。 |
| 根因 | 未合併 + 未佈建 secret。 |
| 相關檔案 | `src/features/design-intelligence/**` |
| 相關資料表 | `design_knowledge` (0027, #88 only) |
| 相關 PR | #88 |
| 是否可立即修 | 否 |
| 需要的測試 | #88 mutation suite（本線不跑其未合併碼當已落地） |
| 修復分支 | #88 |
| 狀態 | PAUSED_OWNED_ELSEWHERE |

---

## GAP-00-008

| Field | Value |
|---|---|
| ID | GAP-00-008 |
| 領域 | TUS / transcode / compare |
| 問題 | feature-map 仍 SPEC_ONLY（docs、無 main source）。#95 宣稱補齊但未合併。 |
| 重現步驟 | `npm run agent:context` → tus-resumable-upload / video-transcode / version-comparison FEATURE_CLAIM_MISMATCH。 |
| 預期行為 | 未落地不得標 IMPLEMENTED。 |
| 實際行為 | docs 存在；main `src/cloud/tusUpload.ts` **不存在**。 |
| 裝置 | all |
| 嚴重度 | P1 |
| 影響 | 大檔上傳仍是單次 XHR（`videoAssets.ts`）。 |
| 根因 | 規格文件先於實作；實作在 #95。 |
| 相關檔案 | `docs/pr27-resumable-video-upload.md`, `docs/pr29-video-optimize-transcode.md` |
| 相關資料表 | `versions.optimized_video_path` (#95 0023) |
| 相關 PR | #95 |
| 是否可立即修 | 否（禁止重做） |
| 需要的測試 | #95 video-flow |
| 修復分支 | #95 |
| 狀態 | PAUSED_OWNED_ELSEWHERE |

---

## GAP-00-009

| Field | Value |
|---|---|
| ID | GAP-00-009 |
| 領域 | voice state machine |
| 問題 | `VoiceRoomState` 只有 `idle \| connecting \| live \| error`。沒有 reconnecting / offline / permission-denied 分立狀態。health 失敗一次會負向快取 30s（誠實不可用，但可能把暫時網路當「沒設定」）。 |
| 重現步驟 | 讀 `src/hooks/useVoiceRoom.ts`。`voiceHealth` 失敗 → `available=false` → 邊界列，不是 dock。 |
| 預期行為 | 未設定 vs 暫時連不上 vs 權限 vs 重連 要分開。 |
| 實際行為 | 四態；health false 整段 session 當不可用直到 TTL。 |
| 裝置 | phone / tablet |
| 嚴重度 | P1 |
| 影響 | 已設定 LiveKit 的部署若 health 偶發失敗，整場看不到加入鈕。 |
| 根因 | PR-03 MVP 範圍。 |
| 相關檔案 | `src/hooks/useVoiceRoom.ts`, `src/cloud/voiceToken.ts` |
| 相關資料表 | `voice_sessions`, `voice_session_participants` |
| 相關 PR | next `cursor/p0-voice-truthful-state-70d9` |
| 是否可立即修 | 部分（hook 未被開 PR 擁有）。本 PR 只做 copy + HTML 拒絕，避免一次改完整狀態機。 |
| 需要的測試 | hook 單元 + e2e voice health HTML |
| 修復分支 | `cursor/p0-voice-truthful-state-70d9` |
| 狀態 | OPEN |

---

## GAP-00-010

| Field | Value |
|---|---|
| ID | GAP-00-010 |
| 領域 | room entry / empty / error |
| 問題 | 任務要求空房（無訊息／無素材／無白板節點）必須能開；核心流要有 Loading / Empty / Error / Retry / Offline / Reconnecting / Permission denied / Service not configured。 |
| 重現步驟 | 原始碼：`emptyRoom()` + `ImageWorkspace`「還沒有討論」；`ChunkLoadError` / `ShellLoading` 存在。未在本 session 用真帳號建房走完整 UI（無測試帳密、不製造 invite）。 |
| 預期行為 | 空房可進；失敗可重試；無空白無限轉圈。 |
| 實際行為 | 原始碼看起來有 empty/chunk 卡；**手機／平板實機與雙客戶端未在本 PR 驗完。** Production 首頁 HTTP 200 可開。 |
| 裝置 | 360×800 / 390×844 / 412×915 / 768×1024 / 820×1180 |
| 嚴重度 | P1 |
| 影響 | 若進房殼在空 snapshot 丟錯，活動房不可用。 |
| 根因 | 進房殼在 `App.tsx` / `MultiBranchRoom.tsx` / `useCloudRoom.ts` — 皆被 #78/#95 擁有。 |
| 相關檔案 | `src/App.tsx`, `src/features/multi-room/MultiBranchRoom.tsx`, `src/cloud/useCloudRoom.ts` |
| 相關資料表 | `rooms`, `room_members` |
| 相關 PR | #78 #95 |
| 是否可立即修 | 否（檔案碰撞） |
| 需要的測試 | 空房 e2e；本線只做 production 首頁截圖 |
| 修復分支 | pause or stack |
| 狀態 | OPEN + PAUSED_OWNED_ELSEWHERE |

---

## GAP-00-011

| Field | Value |
|---|---|
| ID | GAP-00-011 |
| 領域 | mobile / tablet IA |
| 問題 | 第一層應是 返回 / 房名 / 在線 / 語音 / 更多；tabs 只有 對話／白板。 |
| 重現步驟 | `RoomDiscussion` tabs：對話、白板。`collaboration-workspace.test.ts` 契約存在。MultiBranchRoom 另有總覽等（#78 擁有）。 |
| 預期行為 | 次要功能進 bottom sheet。 |
| 實際行為 | 討論殼 tabs 已是兩欄；專案房其他 tab 未在本 PR 重構。 |
| 裝置 | phone / tablet |
| 嚴重度 | P1 |
| 影響 | 小屏密度。 |
| 根因 | 專案房殼歷史。 |
| 相關檔案 | `MultiBranchRoom.tsx` (#78), `RoomDiscussion.tsx` (#95) |
| 相關資料表 | none |
| 相關 PR | #78 #95 |
| 是否可立即修 | 否 |
| 需要的測試 | viewport e2e |
| 修復分支 | `cursor/p1-mobile-tablet-ux-70d9` after owners merge |
| 狀態 | PAUSED_OWNED_ELSEWHERE |

---

## GAP-00-012

| Field | Value |
|---|---|
| ID | GAP-00-012 |
| 領域 | realtime / offline |
| 問題 | 討論 realtime 是整房 reload nudge，不是 row patch。outbox 不持久（重整遺失）見 team-communication audit。`roomSync.ts` / `useCloudRoom.ts` 被開 PR 擁有。 |
| 重現步驟 | 讀 `docs/team-communication/BASELINE_AUDIT.md` §4–6（#94 作者稽核，原始碼仍適用）。 |
| 預期行為 | IndexedDB 只當 cache；不整房 last-write-wins。 |
| 實際行為 | 快照替換；開板 row-patch 已在合併的 PR-02c，但 #78 還要再改 sync。 |
| 裝置 | all |
| 嚴重度 | P1 |
| 影響 | 弱網下討論/白板體感。 |
| 根因 | 架構取捨 + 進行中 PR。 |
| 相關檔案 | `src/cloud/roomSync.ts`, `src/hooks/useDiscussionOutbox.ts` |
| 相關資料表 | discussion / whiteboard |
| 相關 PR | #78 #95 |
| 是否可立即修 | 否 |
| 需要的測試 | offline matrix (`test:collaboration-e2e`) |
| 修復分支 | pause |
| 狀態 | PAUSED_OWNED_ELSEWHERE |

---

## GAP-00-013

| Field | Value |
|---|---|
| ID | GAP-00-013 |
| 領域 | devices |
| 問題 | 無實體 iPhone / LINE / HEVC 證據。自動化只有部分 viewport。 |
| 重現步驟 | 本 session Playwright 模擬視窗（見 artifacts）。無 USB 真機。 |
| 預期行為 | 390 / 412 / 768 / 820 等可操作。 |
| 實際行為 | production 首頁可在模擬視窗開啟；進房／邀請未做（避免製造真實房間與 secret）。 |
| 裝置 | PHYSICAL_DEVICE_PENDING |
| 嚴重度 | P2 |
| 影響 | 發佈簽署。 |
| 根因 | 雲端 VM 無真機。 |
| 相關檔案 | artifacts under `/opt/cursor/artifacts` |
| 相關資料表 | none |
| 相關 PR | this |
| 是否可立即修 | 否 |
| 需要的測試 | 真機手測 |
| 修復分支 | n/a |
| 狀態 | PHYSICAL_DEVICE_PENDING |

---

## GAP-00-014

| Field | Value |
|---|---|
| ID | GAP-00-014 |
| 領域 | tooling |
| 問題 | 本環境沒有 `supabase` CLI；`npm test` 不是 package script；production migration head 未知。 |
| 重現步驟 | `which supabase` → not found。`package.json` scripts 無 `"test"`。 |
| 預期行為 | 遷移探針用既有 `npm run test:migrations`（本機 PostgreSQL）。 |
| 實際行為 | CLI 缺失不阻擋 repo 內 migration harness。 |
| 裝置 | n/a |
| 嚴重度 | P2 |
| 影響 | 無法對 live project 跑 `supabase db dump`。正確：不該從這裡打正式庫。 |
| 根因 | 映像未裝 CLI。 |
| 相關檔案 | none |
| 相關資料表 | n/a |
| 相關 PR | n/a |
| 是否可立即修 | 不需要為了 GAP-00 |
| 需要的測試 | `npm run test:migrations` |
| 修復分支 | n/a |
| 狀態 | BLOCKED（live DB introspection）；repo tests still runnable |

---

## GAP-00-015

| Field | Value |
|---|---|
| ID | GAP-00-015 |
| 領域 | docs hygiene |
| 問題 | `docs/agent-collaboration/third-agent/GAP_MATRIX.md` 仍含未解 `<<<<<<< HEAD` 衝突標記。 |
| 重現步驟 | 打開該檔約 L142。 |
| 預期行為 | 無衝突標記。 |
| 實際行為 | HEAD 與 origin/main 殘段並存。 |
| 裝置 | n/a |
| 嚴重度 | P3 |
| 影響 | 誤導後續 agent。 |
| 根因 | 舊合併殘留。 |
| 相關檔案 | `docs/agent-collaboration/third-agent/GAP_MATRIX.md` |
| 相關資料表 | none |
| 相關 PR | historical third-agent |
| 是否可立即修 | 是，但屬無關文件；本 PR 不改，避免「改別人 docs」。 |
| 需要的測試 | none |
| 修復分支 | optional follow-up |
| 狀態 | OPEN |

---

## GAP-00-016

| Field | Value |
|---|---|
| ID | GAP-00-016 |
| 領域 | room entry / first paint |
| 問題 | 正式站無 `#room=` 時第一屏是顯示名稱 onboard，不是建立房。App origin 的 `/functions/v1/voice-token` 是空白白屏（仍 HTTP 200 HTML）。 |
| 重現步驟 | Playwright 開 https://duigao-k7q2.zeabur.app/ 於 390×844；再開 `/functions/v1/voice-token`。截圖在 `/opt/cursor/artifacts`。 |
| 預期行為 | 第一屏要有 Loading/Empty/Error 之一，不可空白。API 路徑不該當產品頁。 |
| 實際行為 | Onboard 有內容（可接受）。Catch-all API 路徑空白白屏。 |
| 裝置 | 360–820 皆 onboard；390 catch-all 空白 |
| 嚴重度 | P2（onboard 可用）；空白 catch-all 是 001 的 UI 後果 |
| 影響 | 誤開 API 路徑的人看到空白。 |
| 根因 | SPA rewrite + 無該路徑的錯誤殼。 |
| 相關檔案 | `src/App.tsx` onboard（#78/#95 擁有，不改） |
| 相關資料表 | none |
| 相關 PR | this |
| 是否可立即修 | catch-all 不該修成「假裝 API」；錯誤殼要動 App 路由 |
| 需要的測試 | Playwright first-paint |
| 修復分支 | pause App.tsx |
| 狀態 | OPEN（記錄） |

---

## Severity rollup

| Sev | IDs | This PR |
|---|---|---|
| P0 | 001, 002, 004 | 001–002 client fixed; 004 human-blocked |
| P1 | 003, 005–012 | 003 fixed; rest paused/open |
| P2 | 013, 014 | recorded |
| P3 | 015 | recorded |
