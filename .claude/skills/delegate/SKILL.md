---
name: delegate
description: Run an implementation task on the deployed remote-claude (Cloudflare Sandbox) instead of doing it locally, then bring the diff back and verify it. Use when the user wants to offload or delegate a coding task to the executor, dogfood remote-claude on itself, or says 投げる / 委譲する / サンドボックスでやらせる. Also use when a delegated job has failed and its output needs reading.
---

# ジョブを remote-claude に投げる

ローカルで実装する代わりに、deploy 済みの executor（Cloudflare Sandbox）でジョブを走らせ、
**diff を持ち帰って検証する**。手元では Claude Code も Docker も動かさない。

投げる先は「プロンプトを1本実行して diff を返す」だけの基盤。**一発勝負**で、途中で
方針を変えられない（対話的ステアリングは未接続 — roadmap RC-7）。それを前提に判定する。

## 1. 委譲できる作業か判定する

ここで止めるべきものを投げると、30分待って使えない diff が返る。

| 投げていい | 投げてはいけない |
|---|---|
| 自己完結した実装（インターフェースが決まっている） | **deploy と live 検証** — Sandbox に Cloudflare credential を渡さない設計なので原理的に不可（ADR 0002） |
| テスト追加 | 設計判断を含むもの（どの層に置くか、何を規則とみなすか） |
| 機械的なリファクタ | 途中で前提が崩れうるもの、探索が主目的のもの |
| ドキュメント更新 | secret / 外部サービスの認証が必要なもの |
| 明確なバグ修正（再現手順があるもの） | 実行モデル自体の修正（壊れている実行モデルの上では走らせにくい） |

迷ったら**投げない**。ユーザーに「これはローカルでやる」と一言添えて進めるほうが速い。

## 2. 接続を確認する

```bash
./cli/remote-claude.mjs health          # Worker が生きているか
./cli/remote-claude.mjs health --auth   # claude を1回叩いて subscription 認証を確認
./cli/remote-claude.mjs sandboxes       # 未回収の sandbox がないか（あれば枠を埋めている）
```

接続情報は `.remote-claude.json`（gitignore 済み）か環境変数
`REMOTE_CLAUDE_URL` / `REMOTE_CLAUDE_TOKEN`。無ければユーザーに聞く — **推測で作らない**。

`health --auth` が失敗しているなら、そこを直すまで投げても全ジョブが失敗する。

## 3. プロンプトを書く

投げる先には対象リポジトリの `AGENTS.md` があるので、**家のルールを書き写さない**。
プロンプトに必ず入れるのは次の3つ。

1. **何を変えるか** — ファイル名か、少なくとも層（`src/domain/job/` など）まで具体的に
2. **何が「できた」の条件か** — 「`npm test` が通る」「型検査が通る」など、
   サンドボックス内で agent 自身が確認できる形で
3. **触ってほしくない範囲** — 巻き込み事故を防ぐ

```bash
./cli/remote-claude.mjs run "$(cat <<'EOF'
src/domain/job/health.ts に、心拍が一度も来ていないジョブと
心拍が途切れたジョブを区別する判定を足したい。

- 先に src/domain/job/health.test.ts にテストを書く
- assessRunnerHealth のシグネチャは変えない（呼び出し側は application 層）
- 完了条件: npm test と npm run typecheck が通る
- src/infrastructure と src/interface は触らない
EOF
)" --base main --skip-checks
```

### コマンドは job ごとに渡す（重要）

executor の `INSTALL_COMMAND` / `LINT_COMMAND` は **deployment 単位の設定**で、いまは
spindle 用の値（`npm --prefix packages/spindle-core ...`）が入っている。
そして **`skipChecks` は lint/test/build にしか効かない — install は必ず走る。**
つまり黙って投げると、対象が別 repo でも spindle の install が走って**ジョブが落ちる。**

実測（最初の dogfood ジョブ）:

```
[system] ▶ install
[stderr] npm error The `npm ci` command can only install with an existing package-lock.json
[system] ✖ install (exit 1, 874ms)
[system] job failed: step "install" failed with exit code 1
```

なので **`commands` を job ごとに渡す。** 指定しなかったキーは deployment の値を継ぐ。
空文字は「その step を skip」という**指示**なので、そう書けば skip になる。

```ts
const job = await rc.startJob({
  prompt,
  repo: 'https://github.com/r-hashi01/remote-claude.git',
  commands: {
    install: 'npm ci --no-audit --no-fund',
    lint: 'npm run typecheck',
    test: 'npm test',
    build: '',
  },
});
```

こうすると **executor のパイプライン自身が検証する**（結果は `result.steps` に残る）。
プロンプトに「自分で npm test を走らせて」と書く必要はない。`skipChecks` は
「検証を意図的に飛ばす」ときだけ使う。

### 別のリポジトリを対象にする

```bash
./cli/remote-claude.mjs run "..." --base main   # 既定は REPO_URL、commands も deployment のもの
```

CLI は `repo` も `commands` も渡す口を持っていない。別 repo に投げるなら SDK か HTTP を使う
（上の例）。

**GitHub App installation が到達できる repo に限る**（ADR 0010）。届かなければ受付時に
400 で拒否され、cloneまで待たない。届いていない場合のメッセージには installation ID と
追加する場所が入っている。

## 4. 追う

`run` は既定で追尾する。切れた場合や後から見る場合:

```bash
./cli/remote-claude.mjs logs <job-id> -f
./cli/remote-claude.mjs status <job-id>
```

**長時間ジョブを同期的に待ち続けない。** 数分かかるので、追尾を別に走らせるか、
定期的に `status` を見る。待っている間に他の作業を進めていい。

## 5. 結果を取り込む

```bash
./cli/remote-claude.mjs diff <job-id>     # まず読む
./cli/remote-claude.mjs apply <job-id>    # working tree に当てる
```

**当てたら必ず自分で検証する。** サンドボックス内で通ったことは、ここで通ることを意味しない
（install コマンドを skip しているのだから特に）。

```bash
npm test && npm run typecheck
```

そのうえで:

- diff を**読んでから**報告する。ジョブの `finalText`（agent の締めの発言）は要約であって
  監査ではない。実際に何が変わったかは diff にしかない
- 層を越えていないか見る（`src/domain/**` に platform 型が入っていないか）
- commit するかはユーザーに確認する。既定ブランチにいるならブランチを切る

## 6. 失敗の読み方

executor のエラー文は原因を指すように書かれている。**言い換えずにそのまま伝える。**

| 出た文言 | 意味 | 対処 |
|---|---|---|
| `runner stopped responding during "<phase>"` + `runner output:` | コンテナ内の runner が死んだ。直後の runner output が理由 | output を読む。OOM なら分割して投げ直す |
| `no output for N minutes during "<phase>"; presumed stuck` | 生きているが何も出していない | 長い install などが原因 |
| `step "install" failed with exit code 1` | deployment の install コマンドが対象 repo に合っていない | 上記のとおり `commands.install` を渡す |
| `job exceeded <n>ms` | 全体 timeout | 作業を分割する |
| `this executor is pinned to <A> and will not run against <B>` | **executor 側の設定**（`ALLOW_CUSTOM_REPO=false`） | 呼び出し側のバグではない。deployment の設定を直すか、対象を変える |
| `installation cannot reach <owner/name>` | GitHub App installation にその repo が入っていない | GitHub → Settings → Applications → Configure → Repository access |
| `pushing is disabled on it` | `ALLOW_PUSH=false` | diff を持ち帰って手元で push する |
| `cloning ... at branch "<x>" failed` | branch が無いか、権限が無い | base branch 名を確認 |

失敗したジョブでも `usage` と `finalText` は残る。`status <job-id>` で見える。

## 7. 後片付け

```bash
./cli/remote-claude.mjs sandboxes
```

`outstanding` が残り続けるなら回収漏れで、`MAX_CONCURRENCY` の枠を食う。
executor 側は起動時と1分ごとに sweep するので、通常は放置で消える。**消えないなら報告する**
（それは executor のバグで、このリポジトリの roadmap 案件）。

## やらないこと

- **deploy を投げない。** サンドボックスには Cloudflare credential が無い。deploy は
  main への push（`.github/workflows/deploy.yml`）か、ユーザーの手元の `npx wrangler deploy`
- **secret を渡さない。** プロンプトは logs に残る
- **サンドボックスの結果を検証せずに報告しない**
- **同じジョブを投げ直す前に、前のジョブが何を言ったか読む。** 同じ理由で2回失敗するのが
  いちばん時間を捨てる
