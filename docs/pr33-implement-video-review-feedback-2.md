# PR #33：實作影片對稿 2.0

## 背景
PR #32 已合併，但只包含規格文件 `docs/pr32-video-review-feedback-2.md`，尚未有功能實作。本 PR 直接把 #32 規格落地，不再重新設計。

## 核心流程
作者說明 → 夥伴播放 → 時間點／區間回饋 → 快速反應 → 回饋分類 → 作者處理狀態 → 看完 verdict → 審片摘要。

## 必做
- 每個影片版本的作者說明、focus tags、最多 3 個 review prompts
- `＋在這裡留言` 自動抓 currentTime 並暫停
- video-point / video-range 回饋
- 快速反應：👍 可以 / 🤔 看不懂 / ⏩ 太慢 / ⚡ 太快 / 😂 有感 / ✨ 喜歡
- 反應按時間聚合，避免 timeline marker 爆量
- 分類：畫面 / 節奏 / 字幕 / 聲音 / 文案 / 其他
- 處理狀態：待處理 / 處理中 / 已修改 / 不採用
- verdict：可以過 / 小修即可 / 需要再調整，每位使用者每個版本一份最新值
- 最小觀看進度：max watched / completed
- deterministic 審片摘要，不使用 AI
- 手機 timeline marker / range / cluster
- owner/editor/reviewer RLS 與 realtime
- image room 不 regression

## 邊界
- 不新增主導航
- 不做剪輯器、字幕軌、waveform、多軌
- 不修改原影片
- 不重寫 #27 TUS、#29 transcoding、share-preview
- 優先沿用 comments / versions / room_members；新增 schema 必須 migration + RLS

## 驗收
Android / LINE：從分享卡進影片房 → 看到作者說明 → 00:21 快速反應 → 00:37 留時間點回饋 → 建 00:37–00:43 區間 → 看完表態；作者能看到 timeline 聚合、改處理狀態、看到 verdict 與審片摘要。

完成後 `npm run build` 與相關 e2e 全通過，保持 Draft，不自行 merge。