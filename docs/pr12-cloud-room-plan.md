# PR #12 — 雲端多人房間與永久分享連結

## 產品目標

把「文宣討論區」從 **PeerJS 主辦方在線才可靠** 的 best-effort 協作，升級成真正的雲端房間：

> 使用者把 LINE 分享連結傳出去後，任何夥伴都可以隨時打開同一個房間，看到同一份文宣、修改點、圈畫、聊天與視覺提案；主辦方不需要保持頁面開著。

本 PR 不重做手機 UI，也不擴充視覺提案編輯功能。重點只有：**資料可靠、分享可靠、多人同步可靠、離線可恢復。**

---

## 建議技術方向

採 **Supabase** 作為第一個雲端 adapter：

- Auth：匿名登入，維持「輸入名字就進房」的 UX，不新增註冊頁。
- Postgres：持久化房間、版本、修改點、圈畫、聊天與 proposal metadata/data。
- Storage：正式文宣圖片、proposal 素材與背景圖，不再把大量 base64 塞進 Room / Realtime。
- Realtime：房間資料更新；小型 transient presence 可用 Presence/Broadcast。
- RLS：房間成員只能讀寫自己已加入的房間。

環境變數使用：

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

不要把 secret / service-role key 放進前端。

若雲端環境變數沒有設定，現有 IndexedDB + PeerJS/local-only 流程仍要能啟動，方便開發與離線 fallback。

---

## 安全的分享模型

目前網址只有 `#room=<id>`，不能在雲端版直接讓「知道 room id 的所有匿名使用者」讀資料。

改成：

```text
#room=<public-room-id>&invite=<random-secret>
```

規則：

1. 建立房間時，由 client 產生高熵 invite token（Web Crypto）。
2. raw token 只存在分享 URL / client；資料庫只保存 hash。
3. 透過 SQL RPC `create_room_with_invite(...)` 建房並寫入建立者 membership。
4. 新裝置開分享網址後，先匿名登入，再呼叫 `join_room_by_invite(room_id, invite_token, display_name)`。
5. RPC 驗證 token hash 後寫入 `room_members`。
6. 之後所有表格 RLS 都只看 `room_members`，不要靠 URL token 直接放行資料列。
7. 預留 `rotate_room_invite(room_id)`，讓主辦方未來可以重設分享連結。

不要把 invite token 寫進 local logs、analytics、錯誤訊息或資料庫明文欄位。

---

## 資料模型

優先保持現有 TypeScript domain model，雲端 schema 可以正規化。

### rooms

- id UUID / stable public id
- owner_user_id UUID
- title
- invite_hash
- created_at
- updated_at
- archived_at nullable

### room_members

- room_id
- user_id
- display_name
- color
- role: owner / editor
- joined_at
- last_seen_at
- unique(room_id, user_id)

### versions

- id
- room_id
- label
- sort_order
- image_path (Storage path)
- mime_type
- width / height optional
- created_at

### comments

完整對應現有 CommentPin：
- id / room_id / version_id
- author_user_id / author_name / author_color
- x / y
- body / suggestion
- problem_type / priority
- resolved
- created_at / updated_at

### strokes

- id / room_id / version_id
- author_user_id / color / width
- points JSONB
- created_at

### messages

- id / room_id
- author_user_id / author_name / author_color
- body
- created_at

### visual_proposals

視覺提案不要重新設計 editor。保存 PR #10/#11 現有 proposal domain：
- id
- room_id
- version_id
- author_user_id / author_name
- name
- payload JSONB（不包含大型 binary data URL）
- revision integer
- created_at / updated_at

proposal 圖片素材 / 背景：
- binary 存 Storage
- payload 只保存 storage path / metadata

第一版可以使用 proposal row-level revision + optimistic update；若 revision 衝突，重新抓最新版本並提示「提案剛被其他夥伴更新，已載入最新內容」，不要靜默覆蓋。

---

## Storage 結構

建議 private bucket：`room-assets`

```text
rooms/<room-id>/versions/<version-id>/<file>
rooms/<room-id>/proposals/<proposal-id>/<asset-id>/<file>
```

要求：
- bucket 不公開。
- 下載使用 authenticated client + Storage RLS / signed access（依最簡安全方案）。
- 只允許 room member 存取該 room prefix。
- 保留目前圖片大小限制 / 壓縮策略。
- 不把整張文宣 base64 存進 Postgres JSON。

---

## Client 架構

不要把 Supabase 呼叫散落到 `App.tsx`。

新增獨立層，例如：

```text
src/cloud/
  client.ts
  auth.ts
  roomRepository.ts
  roomSync.ts
  assets.ts
  types.ts
  errors.ts
```

必要時再拆：

```text
src/cloud/supabase/
```

目標 API 概念：

```ts
interface CloudRoomRepository {
  createRoom(localRoom, guest): Promise<CloudRoomSession>
  joinRoom(roomId, invite, guest): Promise<CloudRoomSession>
  loadRoom(roomId): Promise<Room>
  saveRoomDelta(...): Promise<void>
  subscribe(roomId, handlers): Unsubscribe
  uploadVersion(...): Promise<CloudAsset>
  syncProposal(...): Promise<void>
}
```

不要要求完全照此 interface；重點是 **App 不直接知道資料庫表格細節**。

---

## Local-first / 離線策略

保留現有 IndexedDB 作為本機 cache，不要刪掉。

期望流程：

### 讀取
1. 分享連結進房
2. 先顯示本機 cache（若有）
3. 連上雲端後拉最新 snapshot
4. merge / replace 後更新畫面與 IndexedDB

### 寫入
1. UI 先 optimistic update
2. IndexedDB 立刻保存
3. 雲端 mutation queue / request
4. 成功 → 顯示「已同步」
5. 失敗 / offline → 顯示「尚未同步，已保存在這台裝置」
6. 網路恢復 → 自動 retry

第一版不用實作複雜 CRDT。

但必須避免「整個 Room snapshot 最後寫入者覆蓋別人」。新增 / 修改資料應使用 entity-level upsert/delete，或有明確 revision 機制。

---

## PeerJS 過渡

本 PR 的目標是讓 **持久狀態以 cloud 為 source of truth**。

PeerJS 可以：
- 保留作舊環境 fallback；或
- 僅保留 transient cursor / view sharing；或
- 若 Supabase Realtime 已完整取代則逐步停用。

不要一次把 `src/lib/peer.ts` 粗暴刪除。

必須先驗證：
- 舊 local room 仍可開
- 未設定 Supabase env 時不 crash
- 雲端房間不依賴 host 在線

---

## 現有本機房間升級

使用者已經有 IndexedDB local rooms，不可直接消失。

Home 最近文宣要能區分：
- 本機
- 已上雲端 / 已分享

本機房間第一次按「分享」時：

```text
建立雲端分享房間 → 上傳 versions → 上傳現有 comments/strokes/messages → 上傳 visual proposals → 產生新 invite URL
```

成功後記錄 cloud room mapping，之後開同一個本機房間直接連回雲端。

若 migration 中途失敗：
- 原本 IndexedDB 房間不可被破壞
- 可安全重試
- 不產生重複 comments / versions

---

## 視覺提案同步

這是本 PR 必須完成的核心驗收，不可只同步 comments/chat。

A 手機：
1. 建立提案 A
2. 換文案
3. 放 Logo
4. 換背景

B 手機打開同一分享 URL：
- 能看到提案 A
- 能切原稿 / 提案
- 能看到相同素材位置與文字

Binary proposal asset 必須來自 Storage，不可依賴 A 的 IndexedDB data URL。

---

## Realtime 行為

至少同步：
- room title
- versions 新增
- comments 新增 / 完成 / 重開
- strokes 新增 / 刪除
- messages
- visual proposals

不要求每個 slider / pointermove 每幀同步。

proposal 拖曳：
- 本機拖曳保持 60fps 感覺
- pointerup / gesture end 後 commit 雲端
- 其他裝置收到 committed state

Presence 可以顯示「目前 N 人在線」，但不要把 presence 當資料持久化來源。

`ViewState`（某個人目前看初稿/改一、wipe 位置）預設應為個人 UI state，不要再強制所有人跟著 host 切畫面；若要做「跟隨主持人」應日後獨立功能。

---

## UX 文案

一般使用者不要看到：
- Supabase
- Postgres
- Realtime
- RLS
- PeerJS

只顯示：
- `已同步`
- `正在同步…`
- `尚未同步，已保存在這台裝置`
- `連線恢復，已同步`
- `這個分享連結已失效，請向主辦方取得新連結`

分享成功後：
- `分享連結已建立，主辦方不用保持頁面開著。`

---

## SQL / migration

請把可重現 schema 放進 repo，不要只在 Supabase Dashboard 點一點。

建議：

```text
supabase/
  migrations/
    <timestamp>_cloud_rooms.sql
```

migration 必須包含：
- tables
- indexes
- constraints
- RLS
- RPC functions
- Realtime publication / authorization（依採用方案）
- Storage policies（若 SQL 可管理）

不要把真實 project URL / key commit 進 repo。

加 `.env.example`。

---

## 安全要求

1. 前端只能使用 publishable key。
2. 不提交 service-role / secret key。
3. 全部 cloud data table 開 RLS。
4. 未加入房間的 user 無法 SELECT / INSERT / UPDATE / DELETE 該房間資料。
5. invite raw token 不存明文。
6. 房間 A 成員不能猜到房間 B id 後讀到資料。
7. Storage 同樣做 room membership policy。
8. SQL function 若使用 SECURITY DEFINER，固定 `search_path` 並只暴露最小權限。
9. 輸入文字保持 React text rendering，不新增 unsafe HTML。

---

## 測試 / 驗收

### Build

- `npm run build`
- TypeScript 無錯

### 至少兩個獨立 browser context

A 建房 → 分享 URL → B 開啟：

1. A 關掉整個分頁
2. B 重新整理
3. B 仍能看到完整房間
4. B 新增修改點
5. A 重新打開 URL
6. A 看得到 B 的修改點
7. A/B 聊天互通
8. 修改點完成狀態互通
9. 新增版本互通
10. proposal A + 素材 + 背景在另一台看得到
11. 兩邊都顯示合理同步狀態

### Offline

1. 進房後斷網
2. 新增一個修改點 / 聊天（依 queue 支援範圍）
3. 畫面不能 crash
4. 顯示「尚未同步，已保存在這台裝置」
5. 恢復網路後自動同步
6. 不產生 duplicate entity

### Security smoke test

用第三個 anonymous user：
- 沒 invite 時不能讀 room
- 錯 invite 不能 join
- 正確 invite 可以 join
- 不能透過直接 table query 讀其他 room

### Mobile

至少：
- 390×844
- 430×932

不能因 cloud loading / sync banner 把海報工作區擠壞。

---

## 不要做

本 PR 不要：
- 新增 email/password 註冊頁
- 做 Google login
- 做完整角色/權限管理後台
- 做通知中心
- 做 AI
- 重做 visual proposal editor
- 大改 MobileWorkspace UI
- 做 CRDT / Yjs，除非現有資料同步真的無法用簡單 entity-level sync 解決
- 把整個 Room JSON 每次變動全部寫回一列
- 把大圖 base64 存進 Realtime/Postgres
- 因為上雲就刪掉 IndexedDB fallback

---

## 完成標準

這個 PR 完成後，用一句話驗收：

> **我把 LINE 連結傳給夥伴後，就算我把手機上的文宣討論區關掉，他晚上再打開連結，也能看到同一份文宣、討論與視覺提案，並繼續操作。**

如果這句做不到，就還不能把 PR 標成完成。
