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

## 已產生的畫布

已發佈的畫布（免安裝，開連結就能看、可匯出 PNG／PDF）：

https://claude.ai/code/artifact/ec10d35e-495d-4fbc-992c-f0fe62198d23

**這個 repo 沒有、也不需要有畫布產生器。** 版控的是這裡的 `.dc.html` 與 `canvas.json`；
產出的 `duigao-design-board.html` 內含約 2MB 的編輯器，列在 `.gitignore`，
不進版控（每次存檔整份重新發佈，塞進 git 只會讓 repo 無謂長大）。

## 重新產生畫布（選用）

只有在要重新發佈畫布時才需要這一步。產生器 `seed-canvas.mjs` 與樣板
`payload.template.html` 隨 Claude Code 的 **design skill** 出貨，不在本 repo 內，
也沒有 npm 套件可裝。取得方式：

1. 在這個 repo 裡開 Claude Code，執行 `/design`。
2. skill 載入時會印出它的 base directory，路徑形如
   `/tmp/claude-0/bundled-skills/<版本>/<hash>/design/`
   （本看板產生時用的是 `bundled-skills` **2.1.250**）。
3. 把該目錄設成 `SKILL_DIR`，在 `.design-board/` 底下執行：

```bash
SKILL_DIR=/tmp/claude-0/bundled-skills/2.1.250/<hash>/design   # 依 /design 印出的實際路徑替換

node "$SKILL_DIR/seed-canvas.mjs" \
  --template "$SKILL_DIR/payload.template.html" \
  --out duigao-design-board.html \
  --title "對稿 Duigao 設計看板" \
  --artboard Main.dc.html --artboard Components.dc.html --artboard Home.dc.html \
  --artboard Review.dc.html --artboard Discussion.dc.html --artboard Project.dc.html \
  --image aios-logo.jpg --canvas canvas.json

node "$SKILL_DIR/seed-canvas.mjs" --check duigao-design-board.html   # 應印出 ok:
```

路徑含版本與 hash，會隨 Claude Code 版本改變 —— 所以請以 `/design` 當下印出的為準，
不要照抄上面的範例路徑。

若手上沒有 Claude Code：`.dc.html` 本身就是純 HTML，可以直接讀、直接改；
只是 `<x-dc>` 與 `{{ }}` 需要 skill 的 runtime 才會渲染成畫面。

## 注意

每張 artboard 的 `<helmet>` 都有 `box-sizing: border-box`（對齊 `src/styles.css` 的 `*`
規則）—— 少了它，root padding 會把內容推出框外被裁掉。
