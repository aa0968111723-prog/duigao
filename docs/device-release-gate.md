# 真機 Release Gate

這份清單是**放行條件**，不是心願清單。規則只有一條：

> 沒有人拿真的裝置做過的項目，一律標 `未驗證`。
> devtools 裝置模擬、Playwright viewport、改 User-Agent、mock Storage
> **都不算通過**，也不能把狀態從 `未驗證` 改成 `通過`。

理由很直接：這些項目失敗的地方，正好是模擬器沒有模擬的那一層——iOS 的
媒體解碼器、Safari 對 HTTP Range 的實作、WKWebView 的手勢政策、系統鍵盤、
真正的 `env(safe-area-inset-*)`。用 Chromium 通過這些項目，等於沒測。

狀態欄只准填三種：`通過`（真機，附日期＋機型）、`失敗`（附 issue）、`未驗證`。

---

## 目前狀態總表

最後更新：2026-08-21（本次 production reliability review）

| 區塊 | 項目 | 狀態 | 備註 |
|---|---|---|---|
| A1 | iPhone Safari：分享連結 → 播放 | **未驗證** | 沒有真 iPhone |
| A2 | iPhone Safari：拖時間軸到後半段立刻跳過去（需 Storage 回 206） | **未驗證** | mock 會回 206，但那只證明我們的程式對，不證明正式 Storage 對 |
| A3 | iPhone Safari：點後半段留言 → 跳到該時間 | **未驗證** | seek 路徑在 Chromium 過，真機 Range 行為未知 |
| B1 | iPhone 相機直出 `.mov` 上傳 | **未驗證** | 沒有 HEVC 測試素材，沒有 iPhone |
| B2 | 桌機 / Android Chrome 開 HEVC 影片時看到明確的相容性說明 | **未驗證（且已知程式有缺口）** | 見下方「已知會失敗的路徑」 |
| C1 | LINE in-app browser（iOS）開分享連結 | **未驗證** | iOS LINE 是 WKWebView，改 UA 的 Chromium 不等於它 |
| C2 | LINE 對話裡的卡片是影片封面而不是純文字 | **未驗證** | OG 產生路徑在 repo 可證，LINE 爬蟲實際行為不可證 |
| C3 | LINE：點一下才開始播（無自動播放） | **未驗證** | 無 autoplay / `playsInline` 可證；`play()` 被拒時的行為見缺口 |
| C4 | LINE：留言、看回覆 | **未驗證** | |
| C5 | LINE：全螢幕成功，或至少不卡住 | **未驗證** | |
| D1 | 非網頁最佳化（moov 在檔尾）的 MP4 上傳後可播 | **未驗證** | 沒有 moov-at-end 素材 |
| D2 | 同上：時間軸長度與 seek 可用 | **未驗證** | |
| E1 | 360×800 直向：播放器／時間軸／工具列同時可用 | **未驗證** | Chromium 量測可證版面不溢出，觸控不可證 |
| E2 | 390×844 直向 | **未驗證** | |
| E3 | 430×932 直向 | **未驗證** | |
| E4 | 橫向手機 | **未驗證（且已知程式有缺口）** | 見下方 |
| E5 | 時間軸 marker 手指點得到 | **未驗證（且已知程式有缺口）** | 見下方 |
| E6 | 系統鍵盤彈出時 composer 的「送出」按得到 | **未驗證** | Playwright 不會叫出系統鍵盤 |
| E7 | 瀏海／底部手勢區沒有蓋到控制列 | **未驗證** | Chromium 的 safe-area inset 恆為 0 |

**通過項目數：0 / 19。** 這份 gate 目前擋著 release，這是它該有的狀態。

---

## 已知會失敗的路徑（Chromium 就測得出來，不需要真機）

這些是 2026-08-21 對抗審查用真實量測抓到的，與上面「未驗證」不同——它們是
**已證實的缺陷**。修好之前，對應的真機項目連測都不用測。

| 代號 | 問題 | 證據 |
|---|---|---|
| G-1 | 橫向手機開啟留言 composer 時，影片框高度變成 0（影片整個消失） | 844×390 量測 `.v-frame` h=0；`video.css` 的「縮小而不是藏起來」規則失效 |
| G-2 | 0:00 的時間軸 marker 被切出畫面左緣，點不到 | 量測 `.v-marker` x=-6、`clippedX: true`；`.m-app { overflow: hidden }` 吃掉左半 |
| G-3 | toast 蓋在 composer 的「送出」上，點下去是關掉提示而不是送出 | toast `z-index: 120` 高於 modal；`.toast-close` 有 `pointer-events: auto` |
| G-4 | 相容性偵測只看容器 MIME，不看 codec：HEVC-in-MP4（iPhone 常見）不會觸發說明 | `canPlayType("video/mp4")` 回 `"maybe"` 即視為可播；`hvc1`/`hev1` 從未被查 |
| G-5 | `play()` 被瀏覽器拒絕（LINE / iOS 無手勢）時錯誤被吞掉，UI 沒有任何說明 | `.catch(() => undefined)`，無 `NotAllowedError` 分支 |
| G-6 | 切換分頁會取消正在進行的上傳 | `pagehide` 無條件 abort |
| G-7 | 360 寬的播放控制鈕只有 36px，低於專案自訂的 44px 觸控標準 | `.v-ctl` min-width 36px vs `--tap: 44px` |

---

## 怎麼跑這份 gate

1. **準備素材**（缺一不可，目前都沒有）：
   - iPhone 相機直出的 HEVC `.MOV`（≥30 秒）
   - 一支 moov atom 在檔尾的 MP4（`ffmpeg -i in.mp4 -c copy out.mp4` 不加
     `-movflags +faststart`）
   - 一支正常的 H.264 fast-start MP4 當對照組
2. **裝置**：一支 iPhone（Safari + LINE）、一支 Android（Chrome + LINE）、
   一台 Windows（Chrome）。
3. 每一項親手做，把狀態欄改成 `通過 YYYY-MM-DD / 機型 / iOS 版本` 或
   `失敗 + issue 連結`。
4. **不要**把整份表一次改成通過。一次一項，做過才改。

## 自動化測試涵蓋到哪裡（以及涵蓋不到哪裡）

`npm run test:video` 用 Chromium + 假 Supabase 驅動真實的 production bundle。
它證明的是「我們的程式邏輯對」：seek 有送出、留言時間對得上、UA 是 LINE 時的
版面沒有破。它**不**證明 iOS 解碼器、Safari Range、WKWebView 手勢或系統鍵盤。

CI（`.github/workflows/build.yml`）現在會跑 migrations（RLS 與房間能力規則，
`REQUIRE_PG=1`，缺資料庫即失敗）與三個瀏覽器套件。這讓「規則被改壞」擋得住，
但它擋不住這份清單上的任何一項——那需要人和裝置。
