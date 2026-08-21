# PR #32：影片對稿 2.0——作者說明、時間回饋與審片流程

## 產品目標

把目前「可以播放影片＋時間點留言」升級成真正適合團隊審片的流程：

> 作者先說明這一版想請大家看什麼 → 夥伴邊看邊在時間點／區間留下回饋 → 用一鍵反應降低回饋門檻 → 作者集中處理 → 看完後快速表態這版能不能過 → 自動形成審片摘要。

核心原則：

1. 手機優先。
2. 夥伴端第一眼維持簡單，不增加新的主導航。
3. 深度能力收在既有「影片對稿」工作區內，用 progressive disclosure。
4. 不把影片對稿做成剪輯器。
5. 不修改原影片。
6. 時間碼是核心資料，不靠使用者手打。
7. 作者／owner/editor 才有管理與整理能力；reviewer 主要專注看、留回饋、表態。
8. 既有圖片文宣流程不能 regression。

---

## 一、作者說明（Review Brief）

影片 workspace 上方、播放器附近加入一張輕量「作者說明」卡。

預設收合摘要：

- 作者說明
- 一行摘要（若有）
- 展開

展開後：

- 這一版說明
- 這次想請大家特別看
- 最多 3 個問題

範例：

> 這是招生短片第一剪。這次主要想確認節奏、笑點，以及 0:42 後面的社團段會不會太快。

關注標籤：

- 畫面
- 節奏
- 字幕
- 聲音
- 文案
- 其他

最多 3 個 review prompts：

1. 前 10 秒有吸引你嗎？
2. 0:35 的轉場會不會太突兀？
3. 結尾 CTA 看得懂嗎？

作者說明屬於房間／版本 review metadata，不是一般留言。

建議：每一版可以有自己的 brief，避免初剪與二剪共用一份已過期說明。

---

## 二、時間點回饋

夥伴看影片時提供最直覺的動作：

> ＋在這裡留言

按下後：

1. 自動記錄 currentTime。
2. 暫停影片。
3. 打開輕量回饋 composer。
4. 顯示時間 badge，例如 `00:37`。
5. 使用者只需要輸入一句話。

不得要求手動輸入時間碼。

沿用既有 comments video-point anchor，避免另建重複模型。

---

## 三、時間區間回饋

支援一段範圍：

`00:37–00:43`

建議 UX：

- 在時間點留言 composer 裡提供「改成一段」
- 或長按／更多 → 選擇結束位置

不要一開始就顯示複雜 in/out 編輯器。

資料沿用既有：

- anchor_type = video-range
- time_seconds
- end_time_seconds

要求：

- end > start
- 不超過 duration
- seek 時可直接跳到 start
- 點 range feedback 時 highlight timeline range

---

## 四、快速反應（Quick Reactions）

降低「懶得打字」門檻。

第一版建議：

- 👍 可以
- 🤔 看不懂
- ⏩ 太慢
- ⚡ 太快
- 😂 有感
- ✨ 喜歡

點一下：

1. 自動記錄 currentTime。
2. 不強制暫停影片。
3. 立即完成。
4. 顯示輕量 toast：`已記在 00:21`。

同一時間附近、同一 reaction 可聚合顯示，例如：

> ⚡ 00:21 太快 ×3

不要每個 reaction 都在 timeline 上塞一顆大型 pin。

需要 mobile-friendly clustering。

---

## 五、回饋類型

影片回饋分類統一為：

- 畫面
- 節奏
- 字幕
- 聲音
- 文案
- 其他

composer 預設可不選，送出後為 `其他` 或保留 nullable，依現有 schema 最小改動決定。

UI 可快速篩選：

- 全部
- 畫面
- 節奏
- 字幕
- 聲音
- 文案

不要讓 category 變成提交回饋的額外負擔。

---

## 六、回饋狀態

作者／editor 可整理每則回饋：

- 待處理
- 處理中
- 已修改
- 不採用

reviewer 端不用看到複雜工作流；最多只看到簡單狀態。

建議保留既有 resolved 能力的 backward compatibility，但不要把 4 狀態硬塞成單一 boolean。

如果需要新增欄位，migration 必須 forward-compatible。

---

## 七、看完後表態（Version Verdict）

影片播放接近結尾或使用者看完時，顯示輕量 bottom sheet：

> 看完了，這版你覺得？

- 可以過
- 小修即可
- 需要再調整

可選：

> 還有一句想說的……

每個使用者對每個 version 只保留一個最新 verdict，可修改。

作者端聚合：

- 可以過 4
- 小修即可 7
- 需要再調整 1

不要用平均分數；這三種語義更符合審片決策。

---

## 八、審片摘要

先做 deterministic summary，不做 AI。

作者看到：

- 已查看人數
- 時間點／區間回饋數
- 快速反應數
- 待處理數
- 已修改數
- verdict 分布
- 集中回饋時間區段

例如：

> 第一剪回饋
> 12 位夥伴已查看
> 18 則時間回饋
> 4 個待處理
>
> 集中位置：
> - 00:18–00:25：節奏偏快
> - 00:42：字幕閱讀時間不足
> - 01:04：聲音相關回饋較集中
>
> 整體：7 人「小修即可」

「集中位置」可用 5 秒或 10 秒 bins 做統計，不需要 NLP。

---

## 九、查看進度（View Progress）

為了讓「12 位夥伴已查看」有真實依據，可記錄 version review progress：

- user_id
- version_id
- max_watched_seconds
- completed_at
- updated_at

只存 review progress，不存播放行為細粒度監控。

避免 creepy analytics：

- 不記每次 play/pause
- 不記裝置細節
- 不做個人觀看熱圖

只為團隊知道「有沒有看過／大約看到哪裡」。

---

## 十、播放器與 timeline UX

手機上維持現有播放器主體。

播放器附近新增最少量操作：

- ＋在這裡留言
- 快速反應入口

timeline 標示：

- 一般回饋：小 marker
- range：短線段
- 聚合 reaction：cluster marker
- 目前選中回饋：明顯 highlight

點 marker：

- seek 到時間
- 打開該回饋卡

不要做 Premiere/Figma 等級 timeline。

---

## 十一、作者與夥伴權限

沿用目前 owner/editor/reviewer。

owner/editor：

- 編輯作者說明
- 設定 review prompts
- 改回饋狀態
- 查看完整摘要

reviewer：

- 看影片
- 留 video-point / video-range feedback
- quick reaction
- verdict
- 查看自己的／團隊公開回饋

不得讓 reviewer 改版本、影片、share preview 或其他管理資料。

---

## 十二、資料模型建議

盡量沿用現有 comments、room_members、versions。

可新增：

### version_review_briefs
- version_id uuid PK/FK
- room_id uuid
- body text
- focus_tags text[] or jsonb
- questions jsonb
- updated_by uuid
- updated_at timestamptz

### video_reactions
- id uuid
- room_id uuid
- version_id uuid
- user_id uuid
- time_seconds double precision
- reaction_type text
- created_at timestamptz

同一 user + version + 時間附近 + reaction 可視需求避免重複點擊。

### version_verdicts
- version_id uuid
- user_id uuid
- room_id uuid
- verdict text check ('pass','minor','revise')
- note text nullable
- updated_at timestamptz
- unique(version_id,user_id)

### version_review_progress
- version_id uuid
- user_id uuid
- room_id uuid
- max_watched_seconds double precision
- completed_at timestamptz nullable
- updated_at timestamptz
- unique(version_id,user_id)

comments 若要 4 狀態，可新增 review_status，或用 feedback extension table；請先檢查現有 schema，選最小侵入方案。

所有新增表：

- RLS
- room membership guard
- anon 不可直接讀寫
- authenticated 只能操作自己有 membership 的 room
- owner/editor 管理權與 reviewer 參與權分離

---

## 十三、離線／Realtime

既有產品支援 mobile/offline/realtime，本功能不能完全破壞這些特性。

最低要求：

- comments 仍走既有 offline queue / realtime
- reactions / verdict 若網路短暫中斷，UI 不要 crash
- 可先 local optimistic，再 retry
- reconnect 後 reload summary

如果 full offline queue 會讓 PR 爆大，允許 reactions/verdict 第一版只做 retry + clear user-facing error，但必須在 PR body 明說限制。

---

## 十四、分享整合

承接最新已合併的影片分享系統。

ShareSheet 可以輕量帶出作者說明摘要，例如：

> 這次主要想請大家看：節奏、字幕、聲音

但不要把完整 review brief 塞進 LINE OG description。

LINE 點進房後，review brief 才是主要引導。

不要重做 share-preview / OG / invite 安全模型。

---

## 十五、不要做

本 PR 不做：

- 影片剪輯
- 字幕軌編輯
- 多軌
- waveform
- AI 自動摘要
- AI 情緒分析
- frame-by-frame drawing
- 公開原影片
- 改寫 #27 TUS
- 改寫 #29 transcoding
- 改寫最新分享 preview 架構
- 新主導航

---

## 十六、驗收

### 作者

1. 上傳影片。
2. 填作者說明。
3. 選 2–3 個關注標籤。
4. 填 1–3 個想問的問題。
5. 分享給夥伴。

### 夥伴

1. LINE 打開影片房。
2. 先看到簡短作者說明。
3. 播到 00:21 點「太快」。
4. 播到 00:37 點「＋在這裡留言」，輸入一句話。
5. 建一則 00:37–00:43 range feedback。
6. 點 timeline marker 能 seek 回原位置。
7. 看完選「小修即可」。

### 作者回來

1. 看到 3 類回饋聚合。
2. 能按類型篩選。
3. 能把某則設成「已修改」。
4. 摘要數字同步更新。
5. verdict 分布正確。

### Regression

- 圖片文宣房不出現影片審片 UI。
- 既有影片播放、seek、±5 秒、音量、倍速不壞。
- 既有 comments/replies/supports 不壞。
- 分享、LINE 預覽不壞。
- reviewer 不可改媒體版本。

---

## 十七、測試

至少新增／擴充：

- video-flow e2e
- review brief CRUD / RLS
- video-point feedback
- video-range feedback
- quick reaction
- duplicate tap guard
- reaction aggregation
- verdict upsert
- verdict summary
- review progress
- feedback status permissions
- owner/editor vs reviewer
- realtime refresh
- image-room regression
- invite/share regression

`npm run build` 必須通過。

migration 必須 commit 到 `supabase/migrations/`，不可只在 Dashboard 手改。

保持 Draft，真實 Android / LINE 驗收前不要 merge。
