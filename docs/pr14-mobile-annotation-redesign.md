# PR #14 — 手機主操作重構：圈範圍、修改與討論

## 核心問題

目前手機版的「圈畫 / 擦除 / 討論」雖然功能存在，但操作模型不直覺，而且多人圈畫後會讓原始文宣被大量筆跡遮住。

這個 PR 的核心原則只有一句：

> **任何回饋都不能永久遮住原稿。**

因此本次不是單純調 CSS，也不是把橡皮擦做大一點，而是重新整理手機主操作模型。

---

## 最終使用者流程

### 看稿

預設永遠是乾淨原稿：

- 不顯示修改點
- 不顯示圈畫
- 不顯示完成勾勾
- 不顯示手寫筆跡
- 視覺提案只在提案模式顯示

### 修改

底部不再直接提供「修改點 / 圈畫 / 擦除」三個永久工具。

改成：

`看｜修改｜討論｜更多`

點「修改」後開一個很小的 action sheet：

1. **點位置留意見**
2. **圈出要調整的範圍**

這兩種操作都是「一次性任務」，完成後自動回到看稿。

---

## 圈畫改成「圈範圍」

### 不再把自由筆跡當最終結果

使用者按「圈出範圍」後：

1. 手指在文宣上圈一個範圍
2. 畫的自由線條只在手指操作當下顯示
3. pointer up 後計算 bounding box
4. 自由筆跡立即消失
5. 保存的是 region，而不是一整條永久 stroke
6. 開啟低摩擦回饋 composer
7. 送出後建立一筆帶 region 的修改建議
8. 自動回到乾淨看稿

建議資料型別：

```ts
export type AnnotationRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};
```

座標全部使用相對於 poster 的 0..1 normalized coordinate。

`CommentPin` 可以新增 optional：

```ts
region?: AnnotationRegion;
```

region comment 的 `x/y` 可以保留為 region center，讓既有定位與 pin 邏輯繼續工作。

---

## 圈選範圍的顯示規則

### 看稿模式

完全不顯示 region。

### 從討論點選某一筆

只顯示該筆 region：

- 淡淡邊框
- 極低透明度底色
- 不蓋住文字
- 可以有 800–1500ms 的短暫 highlight/fade
- 其他所有 region / pin 隱藏

### 修改總覽（若保留）

只有使用者明確打開「顯示標記」時才顯示全部未完成 region。

即使顯示：

- 不顯示原本自由筆跡
- 只顯示細框 + 編號
- 不遮住原圖內容

---

## 圈選 gesture

手機圈範圍模式：

- pointer down 開始收集點
- pointer move 只更新 memory live stroke
- 不寫 IndexedDB
- 不寫 Supabase
- 不送 Realtime
- pointer up 計算 bounding box
- 自動加少量 padding
- clamp 在 poster 0..1 範圍
- 太小的圈選視為 tap / 無效，提示重畫

建議 minimum region 尺寸，例如：

- width >= 0.025
- height >= 0.025

避免 accidental micro-region。

如果使用者畫了一條很直的線，也應以其 bounds + padding 得到可點擊區域。

---

## 圈選完成後的 composer

沿用 PR #13 的低摩擦 PinFields，不要重新造表單。

圈完後 Bottom Sheet：

- 顯示「已圈選這個範圍」
- 快速原因 chips
- 一句話 textarea
- 「送出」
- 「重新圈選」
- 「取消」

不要第一屏顯示：

- priority
- problem type 詳細設定
- suggestion 進階欄位

那些繼續放在「補充」。

如果使用者選了快速原因 chip，應允許它直接作為有效回饋內容或預填文案，降低一定要打字的阻力。

---

## 擦除工具移出主工具列

目前 erase 模式要求手指精準點中 SVG stroke，不適合手機。

本次：

- 手機主 toolbar 移除「擦除」
- 不再要求使用者靠橡皮擦手勢刪筆跡

對新 region annotation：

- 點選該修改建議
- 詳細內容中提供「刪除這個範圍 / 修改建議」或依既有權限行為處理
- 小型操作優先 Undo

對 legacy stroke：

- 預設在看稿隱藏
- 不自動轉換造成資料損失
- 可以放在「更多 → 舊圈畫」或 selected detail 中管理
- 可以刪除整筆 stroke
- 不再讓所有舊 stroke 長期蓋在文宣上

不要做逐像素橡皮擦。

---

## 討論必須永遠可開

目前 DragSheet 依賴 `hasThread`，0 修改點 + 0 聊天時討論面板可能不存在。

修正：

- 「討論」按鈕永遠可以打開 Bottom Sheet
- 不論有沒有 comment/message

空狀態：

```text
還沒有討論

點文宣留下第一個修改建議，
或直接在這裡說一句。

[＋ 新增修改]
```

討論 sheet 建議 tab：

- 修改建議
- 聊天

PR #13 的：

- 我也覺得
- replies
- realtime/offline

全部保留。

---

## 手機 Toolbar 重構

目前：

`看｜修改點｜圈畫｜擦除｜討論`

改成：

`看｜修改｜討論｜更多`

### 看

- 立即退出任何修改任務
- 清除 selection（除非正在從討論定位）
- 原稿乾淨

### 修改

開 action sheet：

- 點位置留意見
- 圈出範圍

### 討論

永遠開啟 discussion sheet

### 更多

保留：

- 視覺提案
- 顏色模式
- 比較
- Undo
- 其他非高頻工具

不要把「圈畫 / 擦除」再塞回第一層。

---

## 一次性任務模式

修改不應是永久 tool mode。

### 點位置

`修改 → 點位置留意見 → 點 poster → composer → send → 自動回看`

### 圈範圍

`修改 → 圈出範圍 → gesture → composer → send → 自動回看`

取消也回看。

這樣使用者不需要記得自己現在還停在 draw / erase / pin mode。

---

## 畫布中的狀態提示

不要再用會蓋住文宣內容的大 Toast/coach 文案。

進入圈範圍時，可以在 poster 上方或 toolbar 上方顯示極輕量狀態列：

`圈出要調整的範圍　取消`

完成圈選後：

`已圈選 ✓`

所有提示：

- 不能蓋住 poster 主要內容
- pointer-events 不阻礙標記
- 短暫 / 可取消

目前類似「點下方修改點…」的 coach 提示要依現在 action 正確顯示，不可在選中圈範圍時還提示另一個工具。

---

## 舊 Stroke 相容策略

現有 Room 有 `strokes`，雲端 PR #12 也已有 strokes table。

不能直接刪資料模型。

本 PR 建議：

1. 新的「圈範圍」不再產生 Stroke
2. 既有 Stroke 仍可讀
3. 看稿預設全部隱藏
4. 必要時在 legacy annotation view 顯示
5. 保留 delete stroke / undo 相容

不要在 migration 中把自由筆跡硬轉 region，因為無法確定每個 stroke 的語意。

---

## Cloud schema

PR #12 已經有 Supabase。

若 `comments` table 尚無 region：

新增 migration，例如：

`supabase/migrations/0003_comment_regions.sql`

可選方案：

```sql
alter table public.comments
add column region jsonb;
```

需要 validation / mapper normalize：

- x/y/width/height finite
- 0..1
- width/height > 0
- x + width <= 1
- y + height <= 1

也可以用四個 numeric columns，如果現有 repository 結構更適合；請選最簡單可維護方案。

RLS 沿用 comments 的 membership 規則，不新增不必要 table。

Realtime / offline queue 必須把 region 一起同步。

---

## Desktop

本次重點是手機。

桌機：

- 不需要重做完整 toolbar
- 但新 region comment 必須能正常 render / 定位 / 查看
- 如果桌機仍保留 draw tool，不能讓它破壞新資料模型
- 優先讓行為與手機一致，但不要因這次任務大改桌機 UI

---

## Accessibility / touch

- toolbar target >= 44px
- discussion 永遠可 keyboard focus
- 修改 action sheet 有明確 labels
- region selected 狀態有 aria-label
- Escape（桌機）可取消一次性修改任務
- touch-action 只在 active region gesture 時阻止必要的 scroll，離開後恢復 poster pinch/pan

---

## 效能

圈選 gesture：

- 不要每 move 都 setState append 無限陣列造成大量 allocations
- 可以用 refs + requestAnimationFrame 或合理採樣
- pointerup 才建立最終 region
- pointerup 才 persist

不要每幀寫 IndexedDB/Supabase。

---

## 驗收情境

至少測：

### 390×844

1. 開房間
2. 原稿乾淨
3. 按「修改」
4. 選「圈出範圍」
5. 圈講師資訊區
6. 手指放開後自由線條消失
7. composer 開啟
8. 留一句「這區資訊太擠」
9. 送出
10. 自動回看稿
11. 原稿上沒有常駐圈線
12. 打開討論
13. 點該建議
14. 只暫時高亮該 region
15. 關閉 / 回看後 region 消失

### 多人

A 建 region comment
→ B 即時看到討論
→ B 看稿仍是乾淨原稿
→ B 點該 comment 才看到 region

### 0 thread

新房間沒有 comments/messages
→ 討論仍然可以打開
→ empty state 有明確 CTA

### legacy strokes

舊房間含多條 strokes
→ 開房後看稿不被遮住
→ 資料仍存在
→ 可透過相容入口查看/刪除

### Offline

離線建立 region comment
→ 本機可見
→ 顯示尚未同步
→ reconnect 後同步
→ 不 duplicate

### 尺寸

- 360×800
- 390×844
- 430×932
- 1280×800

---

## 不要做

- 不做 Photoshop 式自由畫筆系統
- 不做逐像素橡皮擦
- 不做新的大型 Canvas framework
- 不加 Fabric.js/Konva 只為 region
- 不做 AI
- 不重寫 PR #12 cloud layer
- 不重寫 PR #13 feedback/reply/support
- 不重做 visual proposal editor
- 不把所有 annotation 永久顯示
- 不讓 onboarding/toast 蓋住原稿

---

## 完成定義

請只用以下情境判斷是否完成：

> 五個人都對同一張文宣圈不同位置留下意見後，第六個人打開房間，仍然可以先看到完整、乾淨、不被任何圈線遮住的原稿；只有當他點某一筆修改建議時，才會看到那一筆所指的範圍。

如果做不到這句，PR #14 就還沒完成。
