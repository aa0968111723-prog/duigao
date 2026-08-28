# 手機白板 Focus Mode — UI wireflow（PR-02 藍圖）

依任務書 §9-§11；量測基準見 WHITEBOARD_AUDIT §0（現況畫布 48%）。

## 進入/離開

```
討論根畫面（對話｜白板 tabs 照舊）
  └─ 點「白板」tab → 板清單（現有 BoardList，含建立）
       └─ 開板 → 【Focus Mode：全螢幕接管】
            └─ 頂欄「‹」返回板清單（camera/選取狀態保留於記憶體，
               不因切回對話 pane 而卸載 — 白板改為 keep-mounted + hidden）
```

- Focus Mode = `position:fixed inset:0`（畫布延伸到 safe area，
  `env(safe-area-inset-*)` 只作用於工具列內距），跳出 680px 卡片欄。
  房間 header、搜尋列、膠囊列、rd-tabs 在 Focus Mode 全部不渲染。
- `.project-fab` 與 `.asset-ai-fab` 在 Focus Mode **不渲染**（非 z-index
  蓋住，是條件移除 — 任務書明令）。
- 瀏覽器 back：進 Focus Mode pushState 一層，back 手勢/鍵先退出白板
  而非退出房間（Android back 契約）。

## 版面（390×844 主尺寸）

```
┌─────────────────────────────┐
│ ‹  招生規劃      ●●2  ↺ ↻ ⋯ │  頂欄 52px（48-56 規格內）
│                             │
│                             │
│        無限畫布              │  844-52-64-安全區 ≈ 700px
│     （≥75% 視窗面積）        │  700×390/(390×844) ≈ 83% ✓
│                             │
│                             │
├─────────────────────────────┤
│  ▣select 📝note ↦line ✏draw │  底部工具列 64px（含 8px 安全內距）
│  ▤material  ⋯more           │  6 鈕、每鈕 ≥44×44
└─────────────────────────────┘
```

頂欄內容（固定 5 件）：返回、板名（點擊改名，canEdit）、在線成員
（重疊頭像＋數字）、復原/重做、更多（⋯）。

## 底部工具列 → 三態

1. **預設**：選取／便利貼／連線／繪圖／素材／更多。
2. **素材** → Bottom Sheet（既有 project-sheet 模式）：討論訊息／相機／
   相簿／檔案／文宣／影片／企劃／Canva／3D 場佈 — 統一走 Universal
   Intake（metadata 先建、再選落點），來源不可用時項目誠實隱藏
   （沿 health-gate 慣例）。
3. **選取節點後 → 情境工具列**（取代預設列）：編輯／連線／留言／樣式／
   群組／鎖定／更多。多選時：群組／對齊／等距／刪除。

「更多」承載：搜尋、模板、圖層、小地圖、版本、匯出、AI（**AI 只在
這裡＋選取後的情境選單出現** — contextual assistant，非主角）。

## 手勢契約（PR-02 驗收基準，對應 ADR-013 重評檢查點）

| 手勢 | 行為 | 現況→修補 |
|---|---|---|
| 單指拖節點 | 移動（預覽→120ms debounce 持久化） | 有；text 節點改「選取後才可編輯」解 textarea 搶事件 |
| 單指空白拖 | 平移 | 有 |
| 雙指 | pinch 縮放＋**平移**（中點位移併入 camera） | 平移缺→補；pinch 起手清 drag→補 |
| 點兩下 | 節點：編輯；空白：快速便利貼 | 改 pointer 雙擊偵測（不依賴原生 dblclick） |
| 長按節點 | 情境選單（450ms，**slop 8px**） | slop 缺→補 |
| 長按空白 | 新增選單 | 現況死碼→實作 |
| 框選 | 選取工具啟用時單指拖出矩形 | 桌機限定→開放行動（走工具態，不與平移衝突） |
| 套索 | 繪圖工具長按切換 | 缺→補 |
| 編輯節點 | 鍵盤彈出時 camera 自動平移使節點可見（--kb） | 缺→補 |

衝突防護：`touch-action:none`（有）＋Focus Mode 的 history 層（back
手勢）＋viewport meta 不動（可及性：不禁用頁面縮放，畫布內以
touch-action 隔離）。

## 平板（768×1024+，PR-05 預告，PR-02 不做）

Split View（討論｜白板）、可收合側欄、Pencil；PR-02 僅保證 Focus Mode
在平板尺寸不破版（畫布同樣 ≥75%）。

## 可及性

工具列全鈕 aria-label＋≥44px；選取態非僅顏色（框＋handle）；
reduced-motion 時關 camera 動畫；焦點環可見；橫向可用（工具列轉側欄
屬 PR-05，PR-02 橫向維持底欄不破版）。
