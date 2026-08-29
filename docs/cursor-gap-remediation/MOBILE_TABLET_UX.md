# PR-GAP-04 手機與平板 UX — stacked on GAP-02 → #95

Branch: `cursor/p1-mobile-tablet-ux-70d9`  
**Base (must not be main):** `cursor/p0-files-and-outbox-70d9` (PR-GAP-02) @ `782e58646788bbdf754df780b5c0b4ba0a5dec60`

3-level stack: #95 `cursor/complete-missing-features-0897` → GAP-02 → this branch.

Does **not** copy stacks onto main. Does **not** rewrite `#78` `src/features/whiteboard/**` internals or schema. Does **not** start Design Intelligence (#88).

## First-layer contract (existing shell)

Top: 返回 / 房名 / 在線 / 語音 / 更多  
Main switch: 對話 / 白板 only  
Bottom: existing discussion composer / existing whiteboard tools (chrome only)

Search, 總覽, 內容, 企劃, 檔案, AI, 分享, 新增 live behind **更多**. They are not persistent first-layer tabs or FABs.

## What changed

- `src/features/multi-room/roomChrome.ts` — first-layer helper; tablet split when `width >= 768 && moreOpen`
- `MultiBranchRoom.tsx` — more sheet + `history.pushState({ duigaoMore })` for Android back; Escape closes more first
- CSS: 44px first-layer / more targets, `overflow-x: hidden`, safe-area, `--kb` already on composer, `prefers-reduced-motion`, landscape compact header, tablet split grid
- Discussion: 44px 對話／白板 tabs + attach; long-press already `onContextMenu` (system callout suppressed)
- e2e helpers open secondary chrome through 更多

## Viewports

360×800, 390×844, 412×915, 768×1024, 820×1180.

Negative: 360 first layer must not contain persistent 總覽 / AI / 檔案.

## Still not this PR

- #78 whiteboard schema / internals
- #88 Design Intelligence
- Production SPA catch-all
- Voice Leave-during-reconnecting (V-04 / #95)
- Merge #97 → #96 → rebase #98
