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

## BLOCKED_CANVA_CREDENTIALS（PR-05）

- 現況：repo 內無任何 Canva OAuth client id/secret；Canva Connect API 需註冊 app。
- 解法：使用者在 Canva Developer Portal 建 app 並提供 credentials（只放部署端 secrets）。期間 PR-05 以 adapter+fixture+flag 進行。

## BLOCKED_VOICE_PROVIDER（PR-03）

- 現況：無任何 WebRTC/voice provider credential；client 端 API 明確 throw（`src/features/collaboration/voice.ts:11-41`，VOICE_ROOM_MVP=false）。
- 解法：使用者選定並提供 LiveKit / Twilio（或其他）credential；期間 UI 保持誠實的「尚未設定」。

## UNVERIFIED_PRODUCTION_STATE（PR-08 前需解）

- 現況：`npm run agent:context` 顯示 `production migration: unknown (live check required)`；本機無 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`（check-cloud-env strict 會擋 `npm run build`；`build:local` 正常）。E2E 全部打本機 mock，hosted Supabase 的 migration 落差未驗證。
- 影響：不能宣稱 production 與 repo 0016 同步；deploy 驗收（任務規範第十六節）未完成。
- 解法：使用者提供 hosted Supabase URL/key（或在部署平台驗證），跑一次 live migration 盤點與 smoke。

## NOTE_CLAUDE_CLI_ABSENT（非阻塞，如實記錄）

- shell 內 `claude` CLI 不存在（`command not found`）。本工作由 Claude Code agent session 執行，能力等價；依規範不冒充已執行 CLI 健檢。

## NOTE_TKU_ZEN_AGENT_DEPLOYMENT（PR-04 驗收時需解）

- 程式契約兩端已在（HMAC + 測試），但 duigao edge 需要 `TKU_ZEN_AGENT_URL` + shared secret 設定於 Supabase Functions env；目前無法從本機驗證線上是否已設。PR-04 驗收需一次 live 探測（agent-status 端點）。
