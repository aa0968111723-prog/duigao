# Migration 編號預約表 — 團隊溝通線

> 產生於 2026-08-29，依據當下 `git fetch --all --prune` 之後的真實 remote 狀態。
> 規則（任務書 §二十三）：**不得直接猜下一個編號**。任何人要加 migration，
> 先更新這張表，再動手。

## 事實來源

```bash
git fetch --all --prune
git ls-tree --name-only origin/main supabase/migrations/ | tail -1
for b in $(git branch -r --list 'origin/agent/*' --list 'origin/feat/*'); do
  echo "$b -> $(git ls-tree --name-only $b supabase/migrations/ | tail -1)"
done
gh pr list --state open
```

## 目前佔用

| 編號 | 檔名 | 狀態 | 擁有者／分支 | PR |
|---|---|---|---|---|
| 0001–0021 | … `0021_canva_design_pages.sql` | **已在 `main`** | — | 已合併 |
| 0022 | `0022_whiteboard_canonical_columns.sql` | 未合併 | `agent/wb01-canonical-schema` | [#78](https://github.com/aa0968111723-prog/duigao/pull/78) |
| 0023 | `0023_whiteboard_frames.sql` | 未合併 | `agent/wb01-canonical-schema` | [#78](https://github.com/aa0968111723-prog/duigao/pull/78) |
| 0024 | `0024_whiteboard_operations.sql` | 未合併 | `agent/wb01-canonical-schema` | [#78](https://github.com/aa0968111723-prog/duigao/pull/78) |
| 0025 | `0025_whiteboard_versions.sql` | 未合併 | `agent/wb01-canonical-schema` | [#78](https://github.com/aa0968111723-prog/duigao/pull/78) |
| 0026 | `0026_whiteboard_freehand.sql` | 未合併 | `agent/wb01-canonical-schema` | [#78](https://github.com/aa0968111723-prog/duigao/pull/78) |
| 0027 | `0027_design_knowledge.sql` | 未合併 | `agent/design-intelligence-perplexity` | [#88](https://github.com/aa0968111723-prog/duigao/pull/88) |
| 0028 | `0028_design_research_usage.sql` | 未合併、**無 PR** | `agent/di02-analysis-engine`、`di03`、`di04`、`di05`、`di06`（五條分支共用同一號） | 尚未開 PR |
| **0029** | *（保留）* | **本線預約** | `agent/team-communication-mobile-tablet` | PR-COMM-* |
| 0030+ | *（保留）* | 本線預約 | 同上 | PR-COMM-* |

## 本線（團隊溝通）的決定

**PR-COMM-00 不新增任何 migration。**

理由：0022–0028 全部尚未合併，且 0028 被五條 DI 分支同時宣告卻沒有任何 PR
在追蹤它。在人類決定 #78／#88／DI 系列的合併順序之前，任何新編號都可能在
rebase 時撞號。依 §二十三第 6–8 條：

> 6. 若編號衝突，暫停 schema commit。
> 7. 先完成不依賴 schema 的工作。
> 8. 等人類決定合併順序後再重新編號。

因此 PR-COMM-00 的範圍限制在**不需要 schema 變更**就能落地的東西：既有
migration 的行為稽核、能抓到真實缺陷的測試、以及純 client／policy-free 的
P0 修復。需要新表的能力（mentions、receipts、typing、reactions 多表情、
tasks、pins）留到 PR-COMM-02 以後，並在人類確認合併順序後才鑄編號。

## 交接條件

在下列任一情況成立之前，本線不會 commit 任何 `supabase/migrations/*.sql`：

1. #78 已合併進 `main`（0022–0026 落地），且
2. #88 已合併進 `main`（0027 落地），且
3. DI02–DI06 的 0028 有明確歸屬（單一 PR 或撤回）。

滿足後，本線從 `main` 當下最大編號 +1 開始鑄號，並回頭更新這張表。

## 不得做的事

- 不得修改已套用的 migration（0001–0021）。
- 不得在正式 Supabase 專案直接嘗試 migration。
- 不得因為「0029 現在看起來是空的」就直接佔用而不更新本表。
