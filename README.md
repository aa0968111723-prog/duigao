# 文宣討論區

一個手機優先的文宣討論／修改意見標記工具。

> 只標記，不改原稿。

## 部署與 Cloud 分享

正式部署的永久分享依賴 Supabase。Vite 會在 build 階段把 `VITE_*` 寫進前端 bundle，因此 production deployment 必須在 **build 前**提供：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

本 repo 的 `npm run build` 會先執行 strict cloud-env gate；缺少任一值就直接失敗，避免部署一個看得到「分享」按鈕、實際卻無法建立永久連結的版本。

Zeabur Git deployment 由 `zbpack.json` 固定使用：

- build command: `npm run build`
- output dir: `dist`

如果只需要做本機、無 Cloud 的 artifact，明確使用：

```bash
npm run build:local
```

正式分享成功後，網址必須包含：

```text
#room=<uuid>&invite=<token>
```

只有 `#room=<6碼>` 的連結屬於舊版／本機協作連結，不是永久 Cloud 分享。

Supabase Auth 另需啟用 Anonymous Sign-In，讓使用者維持「輸入名字就進房」而不需要 Email/密碼註冊。

## 核心能力

- 名字進房，不強迫註冊
- 多版本文宣（初稿／改一／改二…）
- 修改點與圈範圍
- 修改點回覆與「我也覺得」
- 房間聊天
- 視覺提案（文字、素材、背景等非破壞式 overlay）
- 原稿／提案比較
- IndexedDB 本機保存與離線 fallback
- Supabase 永久房間、Realtime 與 Storage
- PeerJS 作為即時協作補充
- LINE／系統分享
- 手機優先 UI

## 核心產品原則

- 原稿永遠保持乾淨
- 回饋不能永久遮住原稿
- 新功能優先融入既有流程，不增加主畫面負擔
- Cloud 是永久資料來源；IndexedDB 是本機／離線快取
