# 對稿 Duigao 設計看板

Claude Design 畫布的原始檔。每個 `.dc.html` 是畫布上的一張 artboard，
`canvas.json` 決定位置與開啟時的視角。

| 檔案 | 內容 |
|---|---|
| `Main.dc.html` | 基地 — AiOS 標誌、八色光譜、暗色底盤、字級 |
| `Components.dc.html` | 元件 — 按鈕、輸入、版本 chips、圖釘、狀態、工具列、分支卡、修改點卡 |
| `Home.dc.html` | 首頁 390×844 |
| `Review.dc.html` | 對稿工作區 390×844 |
| `Discussion.dc.html` | 討論面板 390×844 |
| `Project.dc.html` | 專案房 390×844 |
| `aios-logo.jpg` | 品牌標誌原圖（760px，嵌進畫布用） |

## 設計依據

尺寸、圓角、字級、控制項高度全部取自 `src/styles.css` 與 `src/mobile.css`，
不是重畫的近似值。看板唯一提出的變更是**分類色**：

- 光譜的紅橙段夾住既有的 `--accent: #c45c4a`，所以光譜是把重點色往兩側接長，不是換掉它。
- 分支類型改用光譜：文宣 `#E4841D`、影片 `#11978D`、企劃 `#8DB52E`、文案 `#D85E2A`
  （現行為影片藍 `#8a9fd1`、企劃／文案棕 `#b99965`）。
- 狀態改用光譜：進行中 `#C83624`、待處理 `#E99E13`、已完成 `#109958`、已封存維持無彩度。

畫面是靜態稿，不是可點的原型。海報內容為示意。

## 重新產生畫布

改完 `.dc.html` 或 `canvas.json` 後重跑（`<skill>` 為 design skill 的目錄）：

```bash
node "<skill>/seed-canvas.mjs" \
  --template "<skill>/payload.template.html" \
  --out duigao-design-board.html \
  --title "對稿 Duigao 設計看板" \
  --artboard Main.dc.html --artboard Components.dc.html --artboard Home.dc.html \
  --artboard Review.dc.html --artboard Discussion.dc.html --artboard Project.dc.html \
  --image aios-logo.jpg --canvas canvas.json
```

產出的 `duigao-design-board.html` 內含約 2MB 的編輯器，已列入 `.gitignore`；
版本控管的是這裡的原始檔。

每張 artboard 的 `<helmet>` 都有 `box-sizing: border-box`（對齊 `src/styles.css` 的 `*`
規則）—— 少了它，root padding 會把內容推出框外被裁掉。
