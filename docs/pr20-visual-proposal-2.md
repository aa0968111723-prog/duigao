# PR #20 — 視覺提案 2.0（手機優先）

## 目標
把「視覺提案」變成手機上好用的**討論工具**，而不是設計軟體。

## 不變的核心原則
1. 原稿永遠乾淨：`Version.imageDataUrl` 絕不被寫入。
2. 提案只是覆蓋在原稿上的 proposal layer。
3. 使用者可以快速試看、比較、回饋、採用。
4. 手機第一眼不能變亂：底部固定 5 顆按鈕，其餘都是選中後才出現的次級控制。

## 資料結構（延續既有 cloud model，不做 migration）
`visual_proposals.payload` 是 `jsonb`，所以 2.0 的新欄位全部放進 payload，
資料庫 schema、RLS、RPC 一律不動。

```
VisualProposal {
  id, versionId, createdAt, updatedAt
  title            // 使用者看到的標題（name 欄位僅為 cloud 舊欄位，永遠鏡射 title）
  description
  type             // text | font | background | asset | layout | color
  status           // draft | discussing | accepted | rejected
  createdBy        // guest id
  authorName
  linkedCommentId? // 綁定的修改點
  supports[]       // { userId, userName, createdAt }
  comments[]       // { id, authorId, authorName, authorColor, body, createdAt }
  items[]          // text | image | shape
  background
}
```

元素只支援 position / size / opacity / visible（外加既有的簡單旋轉），
不做群組、自由變形。

## 手機 UI
- 底部固定五顆：`＋文字`、`＋素材`、`比較`、`提案`、`完成`
- 選中元素後才出現次級控制：縮放 / 透明度 / 顯示 / 刪除（＋文字或色塊專屬欄位）
- `比較` 面板：原稿 / 提案 / 對照（對照附滑桿）
- `提案` 面板：提案卡列表、支持、留言、狀態切換、標題/說明/類型、背景設定

## 連動
- 修改點卡片 → 「建立視覺提案」直接開提案模式並綁定該修改點
- 修改點卡片顯示「相關提案 N」
- 提案卡顯示「來自修改點 N」

## 不做
原稿素材庫、素材管理頁、字體引擎、Figma 級編輯、AI 自動設計，
既有分享系統與修改點主流程都不動。
