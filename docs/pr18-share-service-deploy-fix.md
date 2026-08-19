# PR #18：分享服務部署修復

## 現象
正式站按「分享」顯示「分享服務目前無法使用」。

## 已確認
- Supabase `duigao` 專案存在且 ACTIVE_HEALTHY。
- 專案 URL 與 publishable key 都可取得。
- production migrations 已套用：create_rooms_and_poster_storage、reconcile_cloud_architecture、cloud_rooms、feedback、comment_regions。
- 目前前端只在 build-time 讀取 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`；正式 Zeabur build 沒帶到時，Cloud 會被判定 unavailable。

## 目標
1. Zeabur 正式部署必須帶入 Cloud env，否則 deployment 直接失敗，不再部署一個「分享按鈕必壞」的版本。
2. 不 hardcode Supabase URL / publishable key 到 source code。
3. 保留 PR #17 的安全分享：只有 `#room=<uuid>&invite=<token>` 才算永久分享成功。
4. 使用者端錯誤文案要區分：部署未設定 vs 暫時網路/後端錯誤。
5. 加入 production health self-check / diagnostics，方便確認 Cloud 真正可用。

## 實作要求
- 檢查 package scripts / Zeabur build path，讓 production build 執行 `npm run check:cloud-env` 或等價 gate。
- 若 repo 可使用 Zeabur 設定檔，新增最小設定；不要綁死 secret values。
- 建立 `cloudDeploymentStatus` / diagnostics：production 缺 env 時清楚回報 configuration missing；env 有但連不到時回報 service unavailable。
- ShareSheet 不暴露 Supabase 等工程名詞。
- 增加 build/e2e 測試：有 env 可以建立 invite URL；缺 env build gate fail；錯 env 不假成功。
- 不改 PR #14 手機操作，不改視覺提案，不改資料模型。

## 部署端必要設定
Zeabur service build environment 必須提供：
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

值從既有 Supabase `duigao` 專案取得。不要 commit 真值到 GitHub。

## 完成標準
正式 Zeabur 重新部署後，主辦方按分享能得到帶 `&invite=` 的 URL；關掉主辦方頁面後，另一台手機仍可從 LINE 開啟同一房間。