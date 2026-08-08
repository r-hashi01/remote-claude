# 引き継ぎ

最終更新: 2026-08-08

## いまどこにいるか

remote-claude は **開発基盤として一応動く**。実ジョブが完走し、diff が返り、
`remote-claude apply` でローカルに適用できる。ロードマップの P0 は完了している。

ただし**進行中の未完了作業が1つある**（下記「未解決」）。

## 動くことが確認済みのもの

| | 確認方法 |
|---|---|
| subscription OAuth（credentialがコンテナに入らない） | `remote-claude health --auth` |
| clone → branch → install → claude → lint → commit → diff | 実ジョブ複数回 |
| 51秒の壁の解消 | claude ステップ 98秒で完走 |
| Sandbox の確保と回収 | `remote-claude sandboxes`（outstanding 0） |
| Worker 再起動時のジョブ継続 | 実装済み（意図的な再起動での確認は未実施） |
| ログの完全性 | 全ステップが揃うことを確認 |

## 未解決 — ここから再開する

### 症状

Claude Code の実行を `--output-format stream-json` に切り替え、そのイベントを
Worker 側の `translateEvent`（`src/acp.ts`）で解釈して、

1. 進捗行（`· reading foo.ts` など）
2. トークン消費量

を出す、という変更を入れた。**最終メッセージは出るが、この2つが出ない。**

### 分かっていること

- runner はイベントを出している。ローカル実行で `agent` ストリームが30行確認できた
  ```
  {'system': 31, 'stderr': 1, 'agent': 30, 'stdout': 16}
  ```
- `claude -p --output-format stream-json --verbose` 自体は正しく NDJSON を出す（ローカルで確認）
- 直前に1つ修正した: `capture` が `onLine` 設定時に **stderr も agent イベントとして流していた**。
  非JSONの警告行が混ざってパースに失敗する。stdout のみに限定済み。**この修正の効果は未検証**

### 次にやること

1. `npm run run:local -- <repo> "<prompt>"` で実行し、`log.ndjson` の `agent` 行を
   1件ずつ `translateEvent` に通して、何が返るか確認する。
   ローカルなら数秒で回る。deploy して実ジョブを流すと1周4分かかる
2. `tool_use` を含む `assistant` イベントが来ているか。来ていれば `describeUpdate` の側の問題
3. `result` イベントに `usage` が入っているか

### 罠

- **`node scripts/run-locally.mjs` は使い捨てクローン上で動く。** 直接リポジトリを
  指すと runner が `git add -A && git commit` するので、**untracked ファイルが消える**。
  一度やらかしている
- ローカル実行は**ローカルの Claude Code を使う**。`--no-agent` でスタブに差し替えられる

## 未コミットの変更

すべて `remote-claude` リポジトリ。型チェックとテストは通っている。

```
container/runner.mjs    stream-json化、agentイベント出力、stderr分離
src/acp.ts              usage を TranslationOutput に追加、describeUpdate を追加
src/job-manager.ts      agentイベントを translateEvent 経由で解釈、usage記録、stall検知
src/types.ts            JobUsage、lastProgressAt、usage
scripts/run-locally.mjs ローカル実行ハーネス（新規）
wrangler.jsonc          build.command で埋め込みを強制
```

## どこで作業するか

```bash
cd ~/Documents/others/remote-claude
```

spindle 側（プロダクト）は触らない。いまの作業は実行基盤の話。

### 開発ループ

```bash
# 速い（数秒）— runner の挙動を見る
npm run run:local -- ~/Documents/others/spindle "<prompt>" --no-agent

# 遅い（約4分）— Worker 側まで通す
npx wrangler deploy && remote-claude "<prompt>"
```

**まず速いほうで確かめる。** 今日の不具合の多くは、それで数秒で見つかったはずのものだった。

## 読むもの

- `docs/roadmap.md` — 何が残っているか（P1: RC-4 キャッシュ, RC-6 push/PR）
- `docs/adr/` — なぜこうなっているか。特に 0004（実行モデル）、0007（成果物の一元化）
- `AGENTS.md`（spindle 側） — エージェント向けの規約

## この作業で繰り返した失敗

同じ形の失敗を3回している。**次も踏む可能性が高い。**

1. **持っている情報を使っていない** — `runner.out`、トークン使用量、`logSeq`。
   いずれも手元にあったのに読んでいなかった
2. **成果物の同期を人手に頼った** — イメージへの COPY（ADR 0007 で解消）、
   その後 npm の predeploy フック（`npx wrangler deploy` を直接叩いて迂回）。
   **自分が実際に使う経路を確認せずにガードを置いた**
3. **隔離の前提を外した** — runner は Sandbox で動く前提のコードなのに、
   ローカルの実リポジトリへ向けて実行し、ファイルを消失させた

いずれも「検証する仕組みを足す」より「**その状況が起きえない構造にする**」ほうが正しかった。
