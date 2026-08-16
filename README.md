# 對稿 · 社團活動文宣

把 Canva / Adobe 做好的活動海報，變成一條連結傳給夥伴。

## 功能

- 上傳海報（可多版本：初稿、改一…）
- 彩色 / 黑白 / 左右對切預覽
- 版本並排、滑動比對
- 圖上釘留言、塗鴉
- 一鍵傳到 LINE
- 同一連結多人同時看（WebRTC / PeerJS）

## 使用

1. 打開網站，上傳活動海報
2. 按「建立連結」
3. 分享到 LINE 幹部群
4. 夥伴用手機打開，輸入名字即可一起看、留言

> 海報資料存在瀏覽器（IndexedDB）。主辦方請先打開自己的連結；若夥伴顯示找不到，請主辦再打開一次以同步。

## 本機開發

```bash
npm install
npm run dev
```

## 建置

```bash
npm run build
```

輸出在 `dist/`，可部署到 Vercel 或 GitHub Pages。

## 部署到 Vercel

1. 打開 [vercel.com/new](https://vercel.com/new)
2. Import 這個 GitHub repo：`aa0968111723-prog/duigao`
3. Framework Preset 選 Vite，直接 Deploy
4. 得到網址後即可使用

## 技術

- Vite + React + TypeScript
- IndexedDB 本地儲存
- PeerJS（WebRTC）多人同步
