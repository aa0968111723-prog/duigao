# BLOCKERS — 真實阻塞（含原始錯誤與解法）

更新：2026-08-28

## BLOCKED_ZEABUR_MCP

- 現況：使用者層 `~/.claude.json` 已有 zeabur MCP entry，但 `ZEABUR_TOKEN` 是佔位符 `zat_xxxxxx`，且本 agent session 啟動時未載入該 server（MCP 清單無 zeabur）。
- 影響：無法經 MCP 讀 Zeabur project/service/deployment metadata、logs、env 清單；**不可宣稱已部署或已驗證部署**。
- 解法：使用者到 Zeabur Dashboard 取得真 token 填入，並重啟 Claude Code session。替代：`npx zeabur@latest`（CLI）需登入，同樣需使用者操作。

## BLOCKED_CUTOS_AUTH（PR-07 前置）

- 現況：CUTOS editor REST API 無認證、單租戶；僅 `/api/aios/invoke` 檢查 `CUTOS_API_KEY`（audit 對抗驗證 CONFIRMED）。
- 影響：任何把 CUTOS 暴露給 duigao 房間成員的整合（iframe/proxy）都會讓所有專案對所有訪客可讀寫。
- 解法：先在 CUTOS repo 落 auth + project scoping（獨立 PR），之後才進行 duigao 端 live 整合；期間只做 contract/fixture。

## RESOLVED_CANVA_CREDENTIALS（PR-05，2026-08-28 已解）

- 使用者已提供 Canva Connect 的 Client ID 與 Client Secret（值不入 repo，
  只放 Supabase Edge Functions secrets：CANVA_CLIENT_ID / CANVA_CLIENT_SECRET）。
- PR-05 canva-bridge 可開工（OAuth code flow 走 edge 端，token 不落 client）。

## RESOLVED_VOICE_PROVIDER（PR-03，2026-08-28 已解）

- 使用者選定 **LiveKit**（自有 LiveKit Cloud 專案）。PR-03 已落地並合併
  （#64＋Grok 修復輪 #65）：voice-token edge（HS256 JWT 鑄造、room_role
  成員檢查、health gate）＋VoiceDock（join/leave/mute/roster）＋失敗即清場。
- 殘餘（非 code）：使用者需在 Supabase Dashboard → Edge Functions →
  Secrets 設 LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET；設定後
  需一次雙人真機語音驗收（rounds/pr03 裁決記錄的 residual）。

## RESOLVED_PRODUCTION_STATE（2026-08-28 已解）

- 經 Supabase MCP（專案 uanurolzzgshxrqbooix）盤點：正式庫原先只到 0010、
  **零 edge functions** — 協作工作台在 prod 從未存在。已補齊：
  0011–0019 全部 migration verbatim 套用（42 房回填 42 分支、9 版本全掛
  分支、41 表全 RLS），edge functions 部署 ACTIVE：share-preview
  （verify_jwt=false）、room-ai-context、asset-analysis、cutos-bridge、
  voice-token。
- 殘餘：Dashboard secrets 待使用者設（LIVEKIT_*、APP_ORIGIN、
  TKU_ZEN_AGENT_URL、DUIGAO_AGENT_SHARED_SECRET、CANVA_*）；設後跑
  live smoke。

## NOTE_EMBEDDINGS_UNAVAILABLE（tku Track B，2026-08-28）

- Zeabur AI Hub（hnd1.aihub.zeabur.ai/v1）的兩把 key 皆限 standard 模型組，
  `/embeddings` 回 401 — tku-zen-agent 向量檢索（Track B）需真 OpenAI 平台
  key 或 Zeabur 端開通 embedding 模型組。使用者已知情。

## NOTE_CLAUDE_CLI_ABSENT（非阻塞，如實記錄）

- shell 內 `claude` CLI 不存在（`command not found`）。本工作由 Claude Code agent session 執行，能力等價；依規範不冒充已執行 CLI 健檢。

## NOTE_TKU_ZEN_AGENT_DEPLOYMENT（PR-04 驗收時需解）

- 程式契約兩端已在（HMAC + 測試），但 duigao edge 需要 `TKU_ZEN_AGENT_URL` + shared secret 設定於 Supabase Functions env；目前無法從本機驗證線上是否已設。PR-04 驗收需一次 live 探測（agent-status 端點）。

## NOTE_SLOW_DEVICE_FIRSTUPLOAD（已解 — PR-01c，2026-08-28）

**解法**：create_room RPC 成功即存 pendingSetup 映射；重試經 completeRoomSetup
冪等補完設定並沿用同一間房；錯誤文案分流（setup ≠ 網路）。證據：
video-flow check 24（5 斷言）。原始記錄留存如下。


- 現象：CPU 飽和時（本機 6×burner；CI 2-core 偶發）影片首次上傳在
  ensureCloudRoom 完成 create_room_with_invite＋rooms PATCH＋room_branches
  POST 之後、loadRoom 之前死亡，使用者看到「影片上傳失敗，請檢查網路後再
  試一次」；失敗卡重試會**另開新 cloud room**（原房未綁成）而不是沿用，
  留下空房殘留。request log 證據見 rounds/pr01b 調查（video-flow 檢查 23
  的 self-heal 即為此而設）。
- 影響：慢裝置上的真實使用者；與網路無關的錯誤被說成網路問題。
- 歸屬：PR-01c（手機上傳強化）— 找出 ensureCloudRoom 中被 CPU 餓死的
  環節、錯誤文案分流、重試沿用已建立的房。
