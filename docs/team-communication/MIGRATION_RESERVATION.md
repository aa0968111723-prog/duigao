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

## repo 自己的規則（決定性的一條）

`scripts/agent-release-gate.mjs` 的 `checkMigrationOrder` 要求
**編號必須連續、不得有洞**：

```js
const gaps = numbers.filter((number, index) => index > 0 && number !== numbers[index - 1] + 1);
```

也就是說：**一條分支只能取「自己看得到的最大編號 +1」**，不能為了避開別條
分支而預約一個比較大的號。我一開始寫的「預約 0029」正是被這條規則否決的
——CI 直接紅：

```
✗ MIGRATION_ORDER: Migration naming/order is invalid.
  gap before 0029
FAIL: AUTOMERGE REQUIRES AGENT_GATE_PASS
```

專案的既有慣例（由 CI 強制）優先於我自己發明的預約制。因此本線改取
**`0022`**。

## 目前佔用（以 `main` 為基準）

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
| **0022** | `0022_discussion_author_integrity.sql` | **本線已鑄 — 與 #78 撞號，見下方** | `agent/team-communication-mobile-tablet` | PR-COMM-00 |
| 之後 | *（未鑄）* | PR-COMM-02 以後需要新表時，一律取當時 `main` 的最大編號 +1 | 同上 | PR-COMM-02 以後 |

## 本線（團隊溝通）的決定

**PR-COMM-00 鑄 `0022_discussion_author_integrity.sql`。**

它修的是一個**用真 PostgreSQL、真角色實測出來的安全洞** —— 房間裡任何成員
都能發出一則 `author_user_id` 指向別人的訊息，而訊息是決策與待辦往回指的
原始證據（證據見 `TEST_EVIDENCE.md` §2.1）。

### ⚠️ 已知會與 #78 撞號 —— 需要人類處理

`agent/wb01-canonical-schema`（[#78](https://github.com/aa0968111723-prog/duigao/pull/78)）
也有一個 `0022`（`0022_whiteboard_canonical_columns.sql`）。兩條分支各自從
`main`（`0021`）長出來，各自取下一號，所以**必然撞號**。這是 repo「編號連續」
規則的直接後果，不是誰做錯。

**不會靜默出事**：兩邊合併之後 `checkMigrationOrder` 會看到
`duplicate prefix: 0022` 而讓 gate 紅掉。撞號一定會被 CI 抓到。

**建議處理**：先合併 #78（它比較早、範圍比較大），本線再 rebase 並把
`0022` 改成當時的最大編號 +1。本線的 migration **只依賴 `0014` 已存在**，
不依賴任何其他編號，所以重新編號沒有任何副作用。

建議合併順序（由下而上）：

```
#78 (0022–0026)  →  #88 (0027)  →  DI (0028，需先開 PR)  →  PR-COMM-00（rebase 後重新編號）
```

### 套用順序的風險（正式庫在 0021）

若本線先合併並套用，之後 #78／#88 合併時它們的編號會比已套用的舊，
Supabase CLI 會回報 migration history mismatch。這也是建議把本線排在最後的
理由之一。

## 其餘階段仍然凍結

PR-COMM-02 之後每一階段都需要新表（mentions、receipts、reactions 多表情、
tasks、pins）。那些**不會**在合併順序定案前鑄號 —— 它們不是安全洞，沒有
理由承擔排序風險。PR-COMM-01（捲動、輸入列、草稿與 outbox 持久化）刻意
排在前面，因為它整段不需要 schema。

## 不得做的事

- 不得修改已套用的 migration（0001–0021）。
- 不得在正式 Supabase 專案直接嘗試 migration。
- 不得因為「某個編號現在看起來是空的」就直接佔用而不更新本表。
- 不得為了避開別條分支而預約比較大的編號 —— release gate 不允許有洞。
