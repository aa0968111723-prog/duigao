# PR #18：分享服務部署修復

## 最新根因

正式站按「分享」時，ShareSheet 進入 `unavailable`。目前程式只有在 production bundle 判定 `isCloudConfigured === false` 時才會進入此狀態。

再次檢查正式 Supabase Auth logs 後，使用者本次重試沒有任何新的 `/signup` / anonymous-auth 請求，因此失敗發生在 Auth 之前：**目前 Zeabur 正在服務的 Vite bundle 沒有拿到 `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`。**

Zeabur Dashboard 顯示變數存在，不代表目前已部署的舊 bundle 已包含它們；Vite 的 `VITE_*` 是 build-time 注入，變數變更後必須重新 build/redeploy。

## 本 PR 修復

1. `npm run build` 改成 strict cloud-env gate：
   - 缺 `VITE_SUPABASE_URL` → build fail
   - 缺 `VITE_SUPABASE_PUBLISHABLE_KEY` → build fail
   - placeholder / secret key / 不合法 URL → build fail
2. 新增 `npm run build:local`，需要 local-only artifact 時才明確使用，不讓 production 默默退化。
3. 新增 `zbpack.json`：
   - `build_command = npm run build`
   - `output_dir = dist`
   確保 Zeabur Git deployment 真的走 strict production build。
4. 保留永久分享安全模型：只有成功建立 cloud invite 後才允許複製 / LINE / 系統分享。
5. 不 fallback 成 `#room=<6碼>`。

## Supabase 第二階段檢查

正式 project：`uanurolzzgshxrqbooix`

Cloud env build 成功後，再檢查 Anonymous Sign-In：App 依賴 `signInAnonymously()`。如果 Auth provider 關閉，應看到 `anonymous_provider_disabled`；開啟後才會繼續 `create_room_with_invite`。

## 部署驗收

### A. Build-time env
Zeabur deployment log 必須出現：

`✔ cloud env ready`

如果看不到，deployment 不應成功。

### B. Auth
重新部署後第一次按分享，Supabase Auth log 必須出現新的 `/signup` anonymous request。

### C. Permanent room
成功後 URL 必須為：

`#room=<uuid>&invite=<token>`

### D. Host-offline
A 建房並分享後完全關頁；B 從 LINE 打開仍可載入文宣、修改建議、討論與視覺提案。

## 不在本 PR 處理

- 原稿素材庫
- UI 大改
- 視覺提案新增功能
- Cloud schema 重構
