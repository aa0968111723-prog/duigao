# 文宣討論區

手機優先的文宣討論工具。把 Canva / Adobe 做好的活動文宣變成一條連結傳給夥伴，大家不直接修改原稿，只在畫面上指出哪裡需要調整。

> 海報是主畫面，討論比編輯更快。

## 手機主流程

1. 從 LINE 點開連結 → 輸入名字 → 直接看到文宣
2. 底部選「修改點」→ 點文宣上要調整的位置
3. Bottom Sheet 滑出，打一句話就能送出（建議、分類、優先都是選填）
4. 從底部討論面板查看其他人的意見，處理完標記完成

## 功能

- 多版本文宣（初稿、改一、改二…），手機用水平 chips 切換
- 圖上「修改點」與圈畫；修改點自動編號
- 問題分類、優先程度、建議怎麼改（選填）
- 待修改 / 已完成、一鍵複製完整修改清單
- 分享 Bottom Sheet：複製連結、傳到 LINE、系統分享
- 操作回饋 toast 與「復原」、儲存狀態、首次使用引導
- 同一連結多人同時看（WebRTC / PeerJS）
- 文宣與意見同步到雲端，主辦方沒開著也能打開連結
- 彩色 / 黑白 / 對切 / 並排 / 滑動比較（手機收在「更多」）

## 畫面結構

手機與桌機共用同一份狀態（`App.tsx`），只有外殼不同：

```
src/
  App.tsx                  狀態容器：房間、版本、修改點、連線、分享
  components/
    MobileWorkspace.tsx    手機外殼：頂列、版本 chips、海報、底部工具列
    DesktopWorkspace.tsx   桌機外殼：工具列 + 右側面板
    BottomSheet.tsx        DragSheet（討論清單）與 ModalSheet（新增／分享／更多）
    Stage.tsx              海報與圖釘；座標以「海報本身」為基準
    PinFields.tsx          新增修改點表單（共用）
    CommentCard.tsx        修改點卡片（共用）
    Home.tsx / ShareSheet.tsx / UploadZone.tsx
  toast.tsx                操作回饋 toast
  lib/cloud.ts             雲端鏡像：海報存 Storage、房間存 rooms
  styles.css               共用樣式與桌機版面
  mobile.css               手機元件樣式（≤720px）
  usability.css            toast / 儲存狀態 / 新手引導
```

`mobile.css` 只負責手機元件本身的樣式，不再覆寫桌機版面。

## 開發

```bash
npm install
npm run dev
npm run build   # tsc --noEmit && vite build，輸出到 dist/
```

## 技術

- Vite + React + TypeScript
- IndexedDB 本地儲存（資料格式未變動）
- PeerJS（WebRTC）多人同步
- PWA：manifest + service worker、safe-area、100dvh

## 資料存放

文宣同時存在兩個地方：

1. **瀏覽器本機（IndexedDB）** —— 離線也能看自己開過的文宣
2. **雲端鏡像（Supabase）** —— 讓夥伴在主辦方沒開著時也能打開連結

海報圖片放 Storage，其餘房間內容放 `rooms` 資料表。資料表本身沒有開放讀寫，
一律透過 `get_room` / `save_room` 兩個 SECURITY DEFINER 函式存取，並且一定要帶房間代碼，
所以沒有人能把所有房間列出來。

> 知道連結的人就能看到並留意見（跟直接把連結貼到群組是一樣的意思），請只放不介意群組成員看到的文宣。

雲端位址與金鑰有內建預設值，也可以用環境變數覆寫：

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_KEY=...
```

沒有設定或連不上時，會自動退回「本機 + PeerJS」的原本行為。
