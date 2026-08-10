# 引き継ぎ

最終更新: 2026-08-08

## いまどこにいるか

remote-claude は **開発基盤として一応動く**。実ジョブが完走し、diff が返り、
`remote-claude apply` でローカルに適用できる。ロードマップの P0 は完了している。

前回の引き継ぎにあった未解決（進捗行とトークン消費量が出ない）は**解決済み**。
経緯は下記「解決した問題」に残した。**未完了の作業はいまは無い。**

## 動くことが確認済みのもの

| | 確認方法 |
|---|---|
| subscription OAuth（credentialがコンテナに入らない） | `remote-claude health --auth` |
| clone → branch → install → claude → lint → commit → diff | 実ジョブ複数回 |
| 51秒の壁の解消 | claude ステップ 98秒で完走 |
| Sandbox の確保と回収 | `remote-claude sandboxes`（outstanding 0） |
| Worker 再起動時のジョブ継続 | 実装済み（意図的な再起動での確認は未実施） |
| ログの完全性 | 全ステップが揃うことを確認 |
| 進捗行とトークン消費量 | 実ジョブ2回。下記の出力 |

実ジョブでこう出る。

```
· ▶ claude-code
  · Read repo-url.ts
  · Edit repo-url.ts
  repositorySlug 関数のJSDocコメントを…更新しました
· usage: 6 in / 562 out, 3 turns

status   completed
usage    6 in / 417 out, 3 turns, $0.0867
```

## 解決した問題 — 進捗行とトークン消費量が出なかった件

**翻訳層は最初から正しかった。壊れていたのは配送。**

`--output-format stream-json` に対応した runner を書いたが、埋め込み
(`scripts/embed-runner.mjs`) は npm の `predeploy` フックでしか走らず、
`npx wrangler deploy` を直接叩くと発火しない。**deploy は古い
`src/runner-source.ts` を出荷していた**ので、コンテナの中では
`--output-format` の付かない `claude -p` が動いていた。
agent イベントは1つも生まれておらず、Worker 側には翻訳するものが無かった。

決め手は最初から手元にあった。失敗したジョブの `result.claudeOutput` が
NDJSON ではなく平文だった（`remote-claude status <id> --json` で読める）。
これを先に見ていれば「runner が stream-json を出していない」と即断できた。

対策は ADR 0007 の訂正に記録した。要点だけ:

- 埋め込みを `wrangler.jsonc` の `build.command` に移した。迂回できない
- `src/runner-source.ts` を `.gitignore` に入れた。コミットされた生成物は
  runner の2つ目のコピーであり、実際に stale だった

ついでに2つ直した。

- **runner の子プロセスの stdin を閉じた**（`stdio: ['ignore', …]`）。
  `claude -p` が入力を3秒待ち、`Warning: no stdin data received in 3s` を
  出力ストリームに書き込んでいた。NDJSON チャンネルに非JSONが混ざる
- **`--- claude ---` に `finalText` を出すようにした**。`result.claudeOutput` は
  stream-json 化で生のイベント列になっており、人が読むものではなくなっていた。
  `JobRecord.finalText` / `JobRecord.usage` を `result` イベントから記録している

### 罠

- **`node scripts/run-locally.mjs` は使い捨てクローン上で動く。** 直接リポジトリを
  指すと runner が `git add -A && git commit` するので、**untracked ファイルが消える**。
  一度やらかしている
- ローカル実行は**ローカルの Claude Code を使う**。`--no-agent` でスタブに差し替えられる

## 未コミットの変更

無し。deploy 済み（動作確認したのは version `8cd083da`）。

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

同じ形の失敗を**4回**している。**次も踏む可能性が高い。**

1. **持っている情報を使っていない** — `runner.out`、トークン使用量、`logSeq`。
   いずれも手元にあったのに読んでいなかった
2. **成果物の同期を人手に頼った** — イメージへの COPY（ADR 0007 で解消）、
   その後 npm の predeploy フック（`npx wrangler deploy` を直接叩いて迂回）。
   **自分が実際に使う経路を確認せずにガードを置いた**
3. **隔離の前提を外した** — runner は Sandbox で動く前提のコードなのに、
   ローカルの実リポジトリへ向けて実行し、ファイルを消失させた
4. **1 と 2 が同時に起きた**（進捗行が出なかった件）。predeploy を迂回して古い
   runner を出荷し、その古い runner の出力を新しいコードの不具合として追った。
   `result.claudeOutput` を一度見れば終わっていた

いずれも「検証する仕組みを足す」より「**その状況が起きえない構造にする**」ほうが正しかった。

そして 4 から一つ足すなら —
**症状を出した対象が、いま疑っているコードと同じものか先に確かめる。**
違えば、どれだけ正しいコードでも何時間でも疑える。
