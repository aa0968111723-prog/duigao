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
| **0029** | `0029_discussion_author_integrity.sql` | **本線已鑄**（見下方理由） | `agent/team-communication-mobile-tablet` | PR-COMM-00 |
| 0030+ | *（保留）* | 本線預約，**尚未鑄號** | 同上 | PR-COMM-02 以後 |

## 本線（團隊溝通）的決定

**PR-COMM-00 只鑄一個編號：`0029_discussion_author_integrity.sql`。**

一開始的計畫是「本階段完全不新增 migration」，因為 0022–0028 全部未合併。
稽核跑完之後改了決定，理由必須寫清楚：

`0029` 修的是一個**用真 PostgreSQL、真角色實測出來的安全洞** —— 房間裡任何
成員都能發出一則 `author_user_id` 指向別人的訊息，而訊息是決策與待辦往回指
的原始證據（證據見 `TEST_EVIDENCE.md` §2.1）。把它延到「合併順序定案之後」
等於讓正式站繼續帶著這個洞。

§二十三 第 6 條寫的是「**若編號衝突**，暫停 schema commit」。列舉全部 46 條
remote 分支與 2 個 open PR 之後，`0029` **沒有任何人佔用** —— 不是猜的，是
數出來的（指令見本檔開頭）。所以觸發條件不成立。

**但是套用順序有風險，這件事必須由人類決定**：正式庫在 `0021`。若
PR-COMM-00 先合併並套用 `0029`，之後 #78／#88／DI 合併時 `0022–0028` 會比
已套用的 `0029` 舊，Supabase CLI 會回報 migration history mismatch。

建議合併順序（由下而上）：

```
#78 (0022–0026)  →  #88 (0027)  →  DI (0028，需先開 PR)  →  PR-COMM-00 (0029)
```

若人類決定讓 PR-COMM-00 先合併，套 `0022–0028` 時需要 `--include-all`，或把
`0029` 重新編號。**本線可以配合重新編號** —— `0029` 的內容只依賴 `0014`
已存在，不依賴任何其他編號。

## 其餘階段仍然凍結

PR-COMM-02 之後每一階段都需要新表（mentions、receipts、reactions 多表情、
tasks、pins）。那些**不會**在合併順序定案前鑄號 —— 它們不是安全洞，沒有
理由承擔排序風險。PR-COMM-01（捲動、輸入列、草稿與 outbox 持久化）刻意
排在前面，因為它整段不需要 schema。

## 不得做的事

- 不得修改已套用的 migration（0001–0021）。
- 不得在正式 Supabase 專案直接嘗試 migration。
- 不得因為「0029 現在看起來是空的」就直接佔用而不更新本表。
