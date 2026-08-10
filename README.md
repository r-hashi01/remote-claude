# remote-claude

ローカルマシンではなく **Cloudflare Sandbox 上で Claude Code を実行する**ための実行基盤。

`clone / 編集 / install / build / lint / test / diff / commit` をすべてCloudflare上の隔離Linux環境で行い、
手元には**結果のdiffだけ**が返る。ローカルでClaude Code本体もDockerも動かさない。

```bash
remote-claude "ログイン時の500エラーを調査して修正して"
```

> **スコープ**: この基盤が扱うのは **job**（プロンプトを1本実行してdiffを返す）だけで、
> Project や継続的な仕事の状態は扱わない。それらは呼び出し側のプロダクト
> （[spindle](https://github.com/r-hashi01/spindle)）の責務。

---

## Architecture

```text
Local Mac
   |  ./remote-claude  (Node製の薄いCLI。HTTPを叩くだけ)
   |  HTTPS + Bearer token
   v
Cloudflare Worker  ── control plane のみ。ここではClaude Codeを実行しない
   |
   +-- JobManager (Durable Object)
   |     ジョブ状態 / logs を SQLite に、patch を R2 に保持
   |     同時実行数のゲート (MAX_CONCURRENCY)
   |
   | Sandbox SDK
   v
Cloudflare Sandbox / Container   ── 1 task = 1 Sandbox
   +-- /workspace/repo        clone された対象repository
   +-- claude (公式CLI)        subscription OAuth で認証
   +-- git / node / python / build tools
   |
   +--> api.anthropic.com   (Worker の outbound handler が実tokenを注入)
   +--> github.com          (Worker の outbound handler がGitHub Appの installation token を注入)
        ※ それ以外の宛先はすべて遮断
```

### 設計上の原則

| 原則 | 実装 |
|---|---|
| WorkerでClaude Codeを実行しない | Workerはrouting / task管理のみ。実行は必ずSandbox内 |
| 1作業単位 = 1 Sandbox | `sandboxId = rc-<jobId>`。task終了時に `destroy()` |
| ローカルでbuild/testしない | すべてSandbox内。CLIは`fetch`しかしない |
| ローカルでDockerを使わない | container imageのbuildはGitHub Actions上で実行 |
| credentialをcontainerに置かない | 下記「認証モデル」参照 |

### ファイル構成

4層に分ける。**依存の矢印は内向きだけ**（ADR 0008）。

```text
wrangler.jsonc        Worker/Container/DO/varsの設定
Dockerfile            Sandbox image (claude + toolchain)
src/
  index.ts            entry。DO の export と error→status の対応だけ
  interface/http/     HTTPを受けてJSONを返す。何も判断しない
    router.ts           routing
    auth.ts             bearer認証
  application/        ユースケース。ポート越しに書かれている
    ports/              外界に要求するもの (store / sandbox / github / clock ...)
    job-service.ts      ジョブの受付・起動・追跡・後始末
    testing.ts          ポートのインメモリ実装 (テスト専用)
  domain/             規則。ここは何もimportしない
    job/                Job集約・状態遷移・prompt/branch/repoの規則・生存判定
    agent/acp.ts        Claude Codeイベント → ACP の翻訳
    sandbox/ledger.ts   確保したsandboxと回収の規則
    redaction/          secret masking
    shell/quote.ts      shell引数のquote
  infrastructure/     ポートの実装
    durable-objects/    JobManager / AgentSession / Sandbox
    persistence/        DO SQLite と R2
    github/app.ts       GitHub App JWT署名・installation token・到達性確認
    sandbox/            Cloudflare Sandbox SDK adapter
    config.ts           env varsのparseとdefault
  sdk-contract.ts     SDKの型がAPIと一致していることのcompile-time検査
container/runner.mjs  Sandbox内で実行するpipeline本体 (ADR 0004)
sdk/                  利用者向けクライアント (npm package・下記「SDK」)
cli/remote-claude.mjs  ローカルCLI (依存なし)
.github/workflows/deploy.yml   push時にdeploy
```

`domain` と `application` はネットワークもworkerdも使わずにテストできる。
`npm test` (vitest) がそこを覆っている。

```bash
npm test             # domain / application / sdk
npm run typecheck    # Worker (テストも含む)
npm run sdk:typecheck
```

---

## 認証モデル（重要）

**この環境はAnthropic API Keyを使わない。** Claude Pro / Max の subscription OAuth のみ。

`claude setup-token` で生成した長期tokenを Cloudflare Secret `CLAUDE_CODE_OAUTH_TOKEN` に保存する。

### `CLAUDE_AUTH_MODE=proxy`（デフォルト・推奨）

実tokenは**containerに一切入らない**。

1. containerのclaude processには `CLAUDE_CODE_OAUTH_TOKEN=proxy-injected` というダミー値だけを渡す
2. claudeが `api.anthropic.com` へ出す通信を、Workerの `outboundByHost` handlerが捕捉する（`interceptHttps`）
3. handlerはWorkers runtime側（container外）で動くので、そこで `Authorization: Bearer <実token>` に差し替える

結果として実tokenは、Sandboxのfilesystem・process環境・Docker image・R2 backup・logs のどこにも存在しない。

同じ仕組みでGitHub Appのinstallation tokenも注入するので、**tokenをclone URLに埋め込まない**（`git remote -v` にも `.git/config` にも出ない）。
installation tokenはGitHub Appの秘密鍵から都度JWTを署名して取得する短命（最大1時間）のtokenで、
Worker側（`src/infrastructure/github/app.ts`）でのみ生成・保持され、container内には一切渡らない。

### `CLAUDE_AUTH_MODE=direct`

実tokenをcontainer内のenv varとしてclaude processに渡す。proxyで問題が出た場合の退避用。
Secretからruntimeにのみ注入され、filesystemには永続化されない点は同じ。

### API Key へのfallback防止

3重で保証している。

1. Worker側: `api.anthropic.com` handlerで `x-api-key` ヘッダを**無条件に削除**し、必ずBearerを設定する
2. 実行時: 全commandに `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` を `undefined` で渡して unset、加えてclaude実行行の先頭で `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN`
3. 検証: 各taskの `verify-no-api-key` step が container内で `printenv ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN` を実行し、**何か出力されたらtaskを中止する**

認証状態の疎通確認は `./remote-claude health --auth`（実際にclaudeを1回叩いて確認する）。

---

## Cloudflare 前提条件

| 項目 | 要件 |
|---|---|
| プラン | **Workers Paid（$5/月〜）**。Containers / Sandbox は無料プランでは使えない |
| アカウント | Cloudflare account ID が必要 |
| 必要なリソース | Worker 1つ / Durable Objects 2 class / Container 1つ / （任意）R2 bucket 1つ |
| ローカルに必要なもの | Node.js 22+ のみ。**Dockerは不要**（通常運用時） |

### 手動で用意するCloudflareリソース

R2を使わない初期構成なら **手動作成は不要**。`wrangler deploy` がWorker・DO・Containerをすべて作る。

必要な手作業は次の2つだけ。

1. **Cloudflare API Token の発行**（GitHub Actions用）
   Dashboard → My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"**
   最低限必要な権限:
   - Account / Workers Scripts / Edit
   - Account / Workers R2 Storage / Edit（R2を使う場合のみ）
   - Account / Cloudflare Containers / Edit

2. **Account ID の取得**
   Dashboard の任意のページ右サイドバー、または `npx wrangler whoami`

---

## 必要な Secrets

### Cloudflare Worker Secrets

| 名前 | 用途 | 必須 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude subscription OAuth token（`claude setup-token`で生成） | ✅ |
| `REMOTE_CLAUDE_TOKEN` | このWorkerのAPIを守る共有bearer token | ✅ |
| `GITHUB_APP_ID` | repositoryのclone/push用GitHub AppのID | private repoなら✅ |
| `GITHUB_APP_PRIVATE_KEY` | 同AppのPEM形式非公開鍵（**PKCS#8** 形式。後述） | private repoなら✅ |
| `GITHUB_APP_INSTALLATION_ID` | 同AppをrepositoryへインストールしたときのInstallation ID | private repoなら✅ |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | workspace cacheを使う場合のみ | ✖ |

### GitHub Actions Secrets

| 名前 | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy用 |
| `CLOUDFLARE_ACCOUNT_ID` | deploy用 |
| `CLAUDE_CODE_OAUTH_TOKEN` | （任意）secret同期workflow用 |
| `REMOTE_CLAUDE_TOKEN` | （任意）同上 |
| `GH_APP_ID` | （任意）同上。`GITHUB_`始まりはGitHub側で予約されているため別名 |
| `GH_APP_PRIVATE_KEY` | （任意）同上 |
| `GH_APP_INSTALLATION_ID` | （任意）同上 |

> **絶対にrepositoryへ平文で置かない。** `.dev.vars` と `.remote-claude.json` は `.gitignore` 済み。
> 確認: `git check-ignore -v .dev.vars .remote-claude.json`

---

## 初回セットアップ

### 1. Claude OAuth token を生成

ローカルで一度だけ実行する。

```bash
claude setup-token
```

出力された長期tokenを控える。**このtokenはrepositoryにもDocker imageにも書かない。**

### 2. GitHub App を用意する

repositoryのclone/pushには個人のPersonal Access Token (PAT) ではなく **GitHub App** を使う。
PATと違い、tokenは短命（最大1時間）でapp単位の権限に閉じており、個人アカウントの権限を借用しない。

1. **GitHub App の作成**
   GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**
   - **GitHub App name**: `remote-claude` など任意
   - **Homepage URL**: 任意のURL
   - **Webhook**: **Active** のチェックを外す (無効にする)
   - **Permissions** → **Repository permissions**:
     - **Contents**: **Read-only**（`ALLOW_PUSH=true` にする場合は **Read and write**）
   - **Create GitHub App** をクリック

2. **Private Key の生成と変換**
   - 作成した GitHub App の設定画面下部で **Generate a private key** をクリックし、PEMキー（`original-key.pem`）をダウンロードします。
   - GitHub から発行されるキーは PKCS#1 形式ですが、Cloudflare Workers などの Web Crypto API 環境では PKCS#8 形式が必要です。以下のコマンドで一度だけ変換します：
     ```bash
     openssl pkcs8 -topk8 -nocrypt -in original-key.pem -out pkcs8-key.pem
     ```
   - ※ 複数行にわたる秘密鍵の扱いは、後述の「4. Cloudflare への登録」にあるファイルリダイレクトや、GitHub Actions の Web UI への直接貼り付けを利用することで、エスケープなどの面倒な手作業を一切行わずに登録可能です。

3. **App のインストールと ID 取得**
   - App 設定画面の **Install App** メニューから、対象のリポジトリ（またはオーガナイゼーション全体）に App をインストールします。
   - 以下の3つの値を控えます：
     - **App ID**: App の General 設定画面に表示（`GITHUB_APP_ID` に使用）
     - **Private Key**: 先ほど PKCS#8 形式に変換した鍵の中身（`GITHUB_APP_PRIVATE_KEY` に使用）
     - **Installation ID**: インストール後のブラウザURL末尾（`https://github.com/settings/installations/<INSTALL_ID>`）に表示されている数値（`GITHUB_APP_INSTALLATION_ID` に使用）

4. **Cloudflare への登録**
   - 秘密鍵は複数行の改行を含むため、手動でエスケープやコピペをするのは面倒でミスが起きやすいです。
   - 以下のように、ファイルから直接リダイレクトして流し込むことで、エスケープなしで安全かつ正確に一発で登録できます：
     ```bash
     npx wrangler secret put GITHUB_APP_ID              # 画面からコピーした App ID を入力
     npx wrangler secret put GITHUB_APP_INSTALLATION_ID # 画面からコピーした Installation ID を入力

     # 秘密鍵ファイルを直接リダイレクト（コピペ不要で極めて簡単・確実です！）
     npx wrangler secret put GITHUB_APP_PRIVATE_KEY < pkcs8-key.pem
     ```

   - **GitHub Actions Secrets (GH_APP_PRIVATE_KEY) に登録する場合：**
     GitHub の Secrets 登録画面（Web UI）は、複数行のテキスト入力を完全にサポートしています。特別なエスケープは必要ありませんので、`cat pkcs8-key.pem` の出力を `-----BEGIN PRIVATE KEY-----` から `-----END PRIVATE KEY-----` まで丸ごとコピーし、そのまま入力欄に貼り付けて保存してください。

### 3. API保護用のtokenを生成

```bash
openssl rand -hex 32
```

### 4. Cloudflare へ secret を登録

```bash
cd remote-claude
npm install

npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN    # 手順1の値
npx wrangler secret put REMOTE_CLAUDE_TOKEN        # 手順3の値
npx wrangler secret put GITHUB_APP_ID              # 手順2で控えたApp ID
npx wrangler secret put GITHUB_APP_INSTALLATION_ID # 手順2で控えたInstallation ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < pkcs8-key.pem
```

登録が終わったら **`pkcs8-key.pem`（および元の `original-key.pem`）はローカルから削除する**こと。
`*.pem` は `.gitignore` 済みだが、repository内に置きっぱなしにしない方が安全。

GitHub Actions Secretsに入れておいて `sync-remote-claude-secrets` workflowから流し込んでもよい
（その場合ローカルにtokenを置かずに済む）。

### 5. ローカルCLIの接続先を設定

設定は**デプロイ単位のもので、リポジトリ単位ではない**ため、既定はグローバルに置く。

```bash
mkdir -p ~/.config/remote-claude
cat > ~/.config/remote-claude/config.json <<'JSON'
{
  "url": "https://remote-claude.<your-subdomain>.workers.dev",
  "token": "<REMOTE_CLAUDE_TOKEN と同じ値>"
}
JSON
chmod 600 ~/.config/remote-claude/config.json
```

探索順は「カレントディレクトリとその親を遡って `.remote-claude.json`」→
「`~/.config/remote-claude/config.json`」。特定のリポジトリだけ別のデプロイへ
向けたい場合は前者を置く。環境変数 `REMOTE_CLAUDE_URL` / `REMOTE_CLAUDE_TOKEN`
が最優先。

```json
{
  "url": "https://remote-claude.<your-subdomain>.workers.dev",
  "token": "<REMOTE_CLAUDE_TOKEN と同じ値>"
}
```

環境変数 `REMOTE_CLAUDE_URL` / `REMOTE_CLAUDE_TOKEN` でも可（そちらが優先）。

### 6. アクセス制限（強く推奨）

bearer tokenだけでも公開状態にはならないが、**Cloudflare Accessも併用する**こと。

Dashboard → Zero Trust → Access → Applications → Add an application → **Self-hosted**

- Application domain: Workerのhostname
- Policy: Allow / Emails → 自分のメールアドレスのみ
- CLIから使う場合は Service Auth policy + `CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダ

---

## Deploy

### 通常運用: `git push` するだけ

```bash
git push origin main
```

`**` に変更があると `deploy-remote-claude.yml` が起動し、
GitHub Actionsのrunner上で container image をbuildして `wrangler deploy` まで実行する。
**ローカルMacでDockerは起動しない。**

手動起動は Actions タブ → "Deploy remote-claude" → Run workflow。

### 初回だけ、あるいは緊急時のローカルdeploy

この場合のみローカルでDockerが必要。

```bash
cd remote-claude
npx wrangler deploy
```

### GitHub Actions のセットアップ

repository → Settings → Secrets and variables → Actions → New repository secret

```text
CLOUDFLARE_API_TOKEN   = 手順で作ったAPI token
CLOUDFLARE_ACCOUNT_ID  = npx wrangler whoami で確認した値
```

---

## Task の実行

### CLI

```bash
# 実行してlogを追う（一番よく使う）
./remote-claude "このバグを修正して"

# base branchを指定
./remote-claude "READMEを整理して" --base develop

# すぐ戻る（あとで追う）
./remote-claude "重いリファクタ" --no-follow

# lint/test/build をスキップ
./remote-claude "typoだけ直して" --skip-checks

# 終了後もSandboxを残して調査する
./remote-claude "原因を調べて" --keep

# 状態・log・diff
./remote-claude status <job-id>
./remote-claude logs   <job-id> -f
./remote-claude diff   <job-id>
./remote-claude cancel <job-id>
./remote-claude list

# diffをローカルのworking treeへ適用
./remote-claude apply <job-id>
./remote-claude apply <job-id> --check   # 適用可能かだけ確認

# 疎通確認
./remote-claude health
./remote-claude health --auth   # claudeを1回叩いてsubscription認証を検証
```

### HTTP API

すべて `Authorization: Bearer $REMOTE_CLAUDE_TOKEN` が必要（`/health` を除く）。

| Method | Path | 説明 |
|---|---|---|
| `POST` | `/jobs` | ジョブ開始。即座に `jobId` を返す（202） |
| `GET` | `/jobs` | 直近のジョブ一覧 |
| `GET` | `/jobs/:id` | task状態と結果 |
| `GET` | `/jobs/:id/logs` | `?since=<seq>` `?format=text` |
| `GET` | `/jobs/:id/diff` | unified diff（text/x-patch） |
| `POST` | `/jobs/:id/cancel` | キャンセル |
| `GET` | `/health` | 認証不要のliveness |
| `GET` | `/health/auth` | Claude認証のend-to-end確認 |

```bash
curl -X POST https://remote-claude.<subdomain>.workers.dev/jobs \
  -H "authorization: Bearer $REMOTE_CLAUDE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"prompt": "このバグを修正して", "baseBranch": "main"}'
```

```json
{
  "id": "m9x2k1-4f8a2b1c",
  "jobId": "m9x2k1-4f8a2b1c",
  "status": "queued",
  "prompt": "このバグを修正して",
  "repo": "https://github.com/r-hashi01/spindle.git",
  "baseBranch": "main",
  "branch": "claude/m9x2k1-4f8a2b1c",
  "createdAt": 1775000000000,
  "options": { "skipChecks": false, "keepSandbox": false, "push": false }
}
```

`jobId` は互換のために残している。**新しいコードは `id` を使う**（他のendpointと同じ名前）。
`GET /jobs` も同じ配列を `jobs` と `tasks` の両方の名前で返す。

---

## SDK

HTTPを手で書かないための typed client。`sdk/` にあり、npm packageとして publish できる。

```bash
npm install @r-hashi01/remote-claude-client
```

```ts
import { createClient } from '@r-hashi01/remote-claude-client';

const rc = createClient({ url: process.env.REMOTE_CLAUDE_URL!, token: process.env.REMOTE_CLAUDE_TOKEN! });

const job = await rc.startJob({
  prompt: 'ログイン時の500エラーを調査して修正して',
  repo: 'https://github.com/acme/app.git',   // ALLOW_CUSTOM_REPO=true のとき
});

const finished = await rc.waitForJob(job.id, {
  onLog: (lines) => lines.forEach((l) => console.log(l.line)),
});

if (finished.status === 'completed') {
  const patch = await rc.getDiff(job.id);
}
```

- `waitForJob` は失敗・キャンセルでも**throwせずrecordを返す**。それは例外ではなく結果なので、
  `status` と `error` を読む
- `describeOutcome(job)` が「差分あり / 走ったが何も変わらず / 失敗」を1行にする
- config を持ち回る関数形（`startJob(config, input)`）も同じ操作で公開している
- 層は executor と同じ（`domain` / `application` / `infrastructure`）。transport を差し替えるなら
  `JobGateway` を実装する

型は SDK 側で再宣言してあるが、`src/sdk-contract.ts` が**APIと食い違ったら `npm run typecheck` を落とす**
（ADR 0009）。

publishする側の手順:

```bash
npm run sdk:typecheck
npm run sdk:build          # dist/ に .js と .d.ts
npm --prefix sdk publish   # 初回は npm login とscopeの用意が必要
```

### status の遷移

```text
queued → starting → running → completed
                            ↘ failed
                            ↘ cancelled
```

`queued` は同時実行数の上限（`MAX_CONCURRENCY`、既定3）に達している状態。空き次第FIFOで開始する。

### task pipeline

1. clone（またはcacheからrestore→`fetch`/`checkout`/`reset --hard`）
2. `verify-no-api-key` — API key混入チェック
3. `claude/<job-id>` branchを作成（**main/masterは直接触らない**）
4. `INSTALL_COMMAND`
5. （cache有効時）workspaceのsnapshotをR2へ
6. `claude -p "<prompt>" --permission-mode bypassPermissions`
7. `LINT_COMMAND` / `TEST_COMMAND` / `BUILD_COMMAND`（失敗してもdiffは取得する）
8. 変更があれば `git add -A && git commit`
9. `git status` / `git diff --stat` / patch を保存
10. Sandbox を `destroy()`

Claude Code自身にはcommit/pushをさせない（append-system-promptで禁止し、pipeline側が確定させる）。

---

## Logs

```bash
./remote-claude logs <job-id>      # 全部
./remote-claude logs <job-id> -f   # 追尾
```

Claude Codeとshell commandのstdout/stderrを行単位でDurable Objectに保存している（1 taskあたり最大20,000行）。

task完了後は `status` で以下が確認できる。

- Claude Codeの最終出力
- branch名 / commit SHA
- 変更の有無
- `git diff --stat`
- lint / test / build の結果
- 各stepのexit code と所要時間

**すべての出力は保存前にredactionを通している**（`src/domain/redaction/redactor.ts`）。
既知のsecret値そのものに加え、`sk-ant-*` / `ghp_*` / `ghs_*`（GitHub App installation token）/
`github_pat_*` / `Authorization:` ヘッダ / URL埋め込みcredential をパターンでもマスクする。
secretはAPI responseにも出ない。

Worker側のログは `npx wrangler tail`。

---

## Git の扱い

初期設定は**安全側**に倒してある。

- `main` / `master` を直接変更しない。必ず `claude/<job-id>` branchを作る
- **`git push` はデフォルトで行わない**（`ALLOW_PUSH=false`）
- PR作成・mergeは一切行わない
- 成果物は「patch」として取得し、人間が確認してから適用する

```bash
./remote-claude diff <job-id>          # 目視確認
./remote-claude apply <job-id> --check # 適用可能か確認
./remote-claude apply <job-id>         # ローカルに適用
```

### 後からpushを有効化する

1. `wrangler.jsonc` の `ALLOW_PUSH` を `"true"` に変更
2. GitHub App の Permissions → Repository permissions → **Contents** を **Read and write** に上げる
   （App設定画面で変更後、インストール先で「承認」が必要になる場合がある）
3. task実行時に `--push` を付ける

Worker側の `ALLOW_PUSH` と task側の `--push` の**両方**が揃ったときだけpushする。

---

## Sandbox のライフサイクル / 削除

- task完了時に `sandbox.destroy()` を呼ぶ（`--keep` 指定時を除く）
- `--keep` のSandboxも `SANDBOX_SLEEP_AFTER`（既定 `5m`）でsleepする
- `max_instances: 3` により、そもそも3つ以上のcontainerが同時に立たない
- Durable Objectの再起動でtaskが失われた場合、次回起動時に `failed` として確定させる（`running`のまま残らない）

手動で全部落とす:

```bash
# Sandboxごと消す（DOのstorageも消える点に注意）
npx wrangler deploy   # 再deployでcontainerは入れ替わる

# 個別taskのキャンセル
./remote-claude cancel <job-id>
```

Dashboard → Workers & Pages → remote-claude → Containers からもインスタンスを確認・停止できる。

---

## Workspace cache（未配線）

> **現状これは動かない。** `WORKSPACE_CACHE` / `WORKSPACE_CACHE_TTL` / `BACKUP_BUCKET` は
> 読み込まれ、Sandbox provider に `snapshot()` / `restore()` もあるが、
> **ジョブの経路がそれを一度も呼んでいない。** `on` にしても毎回 fresh clone になる。
> 以下は配線したときの設計として残してある（roadmap RC-10）。

毎回 `clone` + `install` をやり直すのが遅い場合、Sandbox SDK公式のbackup/restore（R2）でキャッシュできる。
**初期構成ではoff**。まずclone方式で動かしてから有効化すること。

### 有効化手順

```bash
npx wrangler r2 bucket create remote-claude-cache
```

`wrangler.jsonc`:

```jsonc
"vars": { "WORKSPACE_CACHE": "on", "WORKSPACE_CACHE_TTL": "604800" },
"r2_buckets": [ { "binding": "BACKUP_BUCKET", "bucket_name": "remote-claude-cache" } ]
```

production では追加でR2 API credentialが必要:

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

（Dashboard → R2 → Manage R2 API Tokens → Object Read & Write）

さらに `vars` に `CLOUDFLARE_ACCOUNT_ID` と `BACKUP_BUCKET_NAME` を追加する。

### R2 cleanup

backupのTTLは**restore時にしか評価されない**。実体の削除はlifecycle ruleで行う。

Dashboard → R2 → remote-claude-cache → Settings → Object lifecycle rules → Add rule

- Prefix: `backups/`
- Delete objects after: **8 days**（`WORKSPACE_CACHE_TTL` の7日より長く）

CLIから:

```bash
npx wrangler r2 object delete remote-claude-cache/cache/workspace.json
npx wrangler r2 bucket delete remote-claude-cache   # 完全に廃止する場合
```

キャッシュのrestoreに失敗しても**taskは失敗しない**。自動でfresh cloneにfallbackする。

---

## 設定一覧（`wrangler.jsonc` の `vars`）

| 変数 | 既定 | 説明 |
|---|---|---|
| `REPO_URL` | spindleのURL | 対象repository |
| `DEFAULT_BASE_BRANCH` | `main` | base branch |
| `CLAUDE_AUTH_MODE` | `proxy` | `proxy` / `direct` |
| `MAX_CONCURRENCY` | `3` | 同時実行task数 |
| `TASK_TIMEOUT_MS` | `1800000` (30分) | task全体のtimeout |
| `CLAUDE_TIMEOUT_MS` | `1500000` (25分) | claude単体のtimeout |
| `SANDBOX_SLEEP_AFTER` | `5m` | idle後にsleepするまで |
| `ALLOW_PUSH` | `false` | pushを許可するか |
| `ALLOW_CUSTOM_REPO` | `true` | job毎に別repoを指定できるか（下記） |
| `WORKSPACE_CACHE` | `off` | R2 workspace cache |
| `SANDBOX_ALLOWED_HOSTS` | 下記 | Sandboxの通信許可先 |
| `INSTALL_COMMAND` | `""` | 空ならskip |
| `LINT_COMMAND` | `""` | 空ならskip |
| `TEST_COMMAND` | `""` | 空ならskip |
| `BUILD_COMMAND` | `""` | 空ならskip |

> **spindleはまだbuild/test/lintを持たないため、4つのcommandは空にしてある。**
> 実装が入ったら `wrangler.jsonc` に記入して再deployすること。例:
> `"INSTALL_COMMAND": "npm ci"`, `"TEST_COMMAND": "npm test"`

`max_instances` は `MAX_CONCURRENCY` 以上にしておくこと（`containers` セクション）。

---

## セキュリティ

| 観点 | 対策 |
|---|---|
| Sandbox isolation | 1 task = 1 container。task毎に破棄 |
| Credential isolation | proxyモードでは実tokenがcontainerに存在しない |
| Secret masking | 全出力を `redact.ts` 経由。既知値＋パターンの二重マスク |
| Command injection | 外部由来の文字列はすべて `shellQuote()` で単一引用符化 |
| Arbitrary repository URL | https / github.com / credential無し のみ。さらに**GitHub App installationが到達できるrepoに限る**（受付時にGitHubへ確認） |
| API authentication | bearer token必須。`crypto.subtle.timingSafeEqual` で比較。**未設定なら全リクエストを503で拒否（fail closed）** |
| Task timeout | task/claude それぞれにtimeout。`AbortSignal` でcancel伝播 |
| Network access | deny-by-default。allowlist外は遮断。DNSはCloudflare固定 |
| Log leakage | secretはlogs・API response・error messageのいずれにも出ない |

**認証なしのpublic endpointにはならない**設計になっている（`REMOTE_CLAUDE_TOKEN` 未設定時は503）。
それに加えてCloudflare Accessを重ねること。

この環境は**個人利用専用**。第三者のリクエストを自分のsubscription credentialで処理する構成にはしないこと
（Anthropicの利用規約違反になる）。歯止めは `REMOTE_CLAUDE_TOKEN` とCloudflare Accessであって、
repoの数ではない。

### 別のrepositoryを指定する

`ALLOW_CUSTOM_REPO=true`（既定）なら `POST /jobs` に `repo` を渡せる。
**どのrepoで走らせられるかを決めるのは、この設定ではなくcredentialの到達範囲**（ADR 0010）:

1. URLの形を検査する — https / `github.com` / credential埋め込み無し
2. **GitHub App installation がそのrepoを見えるかGitHubに問い合わせる。**
   見えなければ `400` で拒否し、**cloneまで待たない**
3. `REPO_URL` と同じrepoを別の書き方（`.git` の有無・末尾スラッシュ・大文字小文字）で
   渡した場合は「別repo指定」とは扱わない

許可リストは持たない。持てば installation が許すものの部分集合を二重管理することになり、
必ず古くなる。**狭めたいときは GitHub App installation から repository を外す。**

`ALLOW_CUSTOM_REPO=false` にした deployment が `repo` を受けた場合、
エラーには両方のrepo名と「executor側の設定である」ことが入る:

```
this executor is pinned to https://github.com/r-hashi01/spindle.git and will not run
against https://github.com/acme/app.git: custom repositories are disabled on the
executor. Set ALLOW_CUSTOM_REPO=true in its wrangler.jsonc vars and redeploy, or
point it at that repository.
```

---

## Troubleshooting

### `unauthorized` が返る
`REMOTE_CLAUDE_TOKEN` の不一致。`.remote-claude.json` の値とWorker secretを揃える。
再設定は `npx wrangler secret put REMOTE_CLAUDE_TOKEN`。

### `REMOTE_CLAUDE_TOKEN is not configured` (503)
Worker側にsecretが未設定。fail closedで正しい挙動。上記コマンドで設定する。

### `health --auth` が失敗する
1. `CLAUDE_CODE_OAUTH_TOKEN` が正しいか（`claude setup-token` を再実行して入れ直す）
2. tokenの有効期限切れ
3. `SANDBOX_ALLOWED_HOSTS` に `api.anthropic.com` が含まれているか

### task が `verify-no-api-key` で失敗する
container内に `ANTHROPIC_API_KEY` が存在している。Dockerfileや `vars` に混入していないか確認。
**これは意図的な安全装置**なので、無効化せず原因を除去すること。

### clone が失敗する（private repository）
`remote_claude_config_error` が返る場合は `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` /
`GITHUB_APP_INSTALLATION_ID` のいずれかが未設定。それ以外の認証エラーは次を確認する。

1. GitHub App が対象repositoryに **インストールされているか**（Install App画面）
2. Permissions → Repository permissions → **Contents: Read** 以上か
3. `GITHUB_APP_PRIVATE_KEY` が **PKCS#8**（`-----BEGIN PRIVATE KEY-----`）形式か。
   PKCS#1（`-----BEGIN RSA PRIVATE KEY-----`）のままだと
   `failed to import GITHUB_APP_PRIVATE_KEY` エラーになる。`openssl pkcs8 -topk8 -nocrypt` で変換する
4. `GITHUB_APP_INSTALLATION_ID` が対象repository/orgへのインストールのものと一致しているか

### build / test が OOM で落ちる
`wrangler.jsonc` の `instance_type` を `"basic"` → `"standard"` に上げる。
コストは上がるので、必要になってからにすること。

### Docker build が GitHub Actions で失敗する
base imageに存在しないコマンドを `Dockerfile` に足していないか確認（例: `corepack` は入っていない）。
ローカルで再現するには `cd remote-claude && npx wrangler deploy --dry-run --outdir /tmp/build`。

### task が `running` のまま止まる
Worker再起動でDurable Objectが落ちた可能性。次回のDO起動時に自動で `failed` に確定する。
`./remote-claude cancel <job-id>` でも解消できる。

### logs が途中で止まる
1 taskあたり20,000行の上限に達している。`--skip-checks` で出力量を減らすか、promptを分割する。

### Worker自体のログを見たい
```bash
cd remote-claude && npx wrangler tail
```

---

## コスト要因

Workers Paid（$5/月）に加えて、従量課金が発生しうる箇所。

| 要因 | 内容 | 抑制策 |
|---|---|---|
| **Container 実行時間** | vCPU秒 / メモリGiB秒 / ディスクGB秒。**最大の要因** | task完了時に即`destroy()`、`SANDBOX_SLEEP_AFTER=5m`、`max_instances: 3` |
| Container image storage | build済みimageの保管 | imageを肥大化させない（Dockerfileを最小限に） |
| Durable Objects | requests + SQLite storage | 7日でtaskを自動削除、logs上限20,000行 |
| Workers requests | CLIのpolling含む | followのpolling間隔は0.4〜1.5秒に調整済み |
| R2 | storage + Class A/B operations | lifecycle ruleで8日削除。cacheはデフォルトoff |
| **Anthropic** | **subscriptionの定額のみ。従量課金は発生しない** | API keyを使わない構成のため |

コストが気になる場合に最初に見るべき設定:

```jsonc
"MAX_CONCURRENCY": "1",        // 同時実行を絞る
"SANDBOX_SLEEP_AFTER": "2m",   // より早くsleep
"instance_type": "basic"       // 上げない
```

Dashboard → Workers & Pages → remote-claude → Metrics、および Billing で実績を確認できる。

---

## 現時点の制約

- **spindleにbuild/test/lintが未定義**なため、該当stepは全てskipされる。実装後に `wrangler.jsonc` へ記入が必要
- task結果はpatchとして保存され、Sandboxは破棄される。Sandbox内のbranchは残らない（`--keep` を使わない限り）
- Durable Objectが落ちた場合、実行中のtaskは復旧せず `failed` になる（再実行が必要）
- workspace cacheは実装済みだがデフォルトoff。有効化にはR2の追加設定が必要
- `queued` のtaskはWorker再起動で失われる（永続queueではない）
- task履歴の保持は7日
- 対話的なClaude Code（承認プロンプト）は使えない。`--permission-mode bypassPermissions` の非対話実行のみ
- CLIのfollowはlong-pollingではなくpolling

---

## ACP セッション（対話モード・実験的）

`/jobs` の「一発実行してdiffを返す」モデルに加えて、**多ターンの対話セッション**を
[Agent Client Protocol (ACP) v1](https://agentclientprotocol.com) 互換の形で提供する。

エディタ（Zed / neovim など）から、リモートのSandbox上のClaude Codeを
**あたかもローカルのagentのように**扱える。ローカルにはJSON-RPCを中継するだけの
軽量Nodeプロセスが1つ立つだけで、モデル実行もbuildも一切行わない。

```text
editor ──ACP/stdio──▶ cli/acp-bridge.mjs ──HTTPS+SSE──▶ Worker ──▶ Sandbox (claude)
```

### なぜbridge方式か

ACPの **remote transport (Streamable HTTP / WebSocket) はまだRFD提案段階**で、
仕様として確定しているのは stdio のみ。そこで:

- エディタ側には**確定仕様の stdio** で話す → Zed等で**今日動く**
- リモート区間は独自のSSE（ACPのRFD案に寄せた形）
- remote transportが安定したら `cli/acp-bridge.mjs` だけ差し替えればよい

### 実装済みの範囲

| ACP要素 | 状態 |
|---|---|
| `initialize` (protocolVersion 1) | ✅ |
| `session/new` | ✅ |
| `session/prompt`（多ターン） | ✅ `--resume` でClaude Code側の文脈を継続 |
| `session/cancel` | ✅ |
| `session/update` → `agent_message_chunk` | ✅ |
| `session/update` → `agent_thought_chunk` | ✅ thinking blockを変換 |
| `session/update` → `tool_call` / `tool_call_update` | ✅ kind/title/locations/diffを付与 |
| `session/update` → `plan` | ✅ **TodoWriteをACPのplanへ変換**（エディタ上でチェックリスト表示） |
| `session/update` → `usage_update` | ✅ |
| `session/request_permission` | ❌ 未実装（下記） |
| `fs/*` / `terminal/*` | ❌ 未実装。作業ツリーはSandbox側にあるため必須ではない |
| `session/load` | ❌ 未実装 |

### 承認フロー（未実装・設計のみ）

ACPの目玉である「tool実行前にエディタで承認する」フローは**まだ入れていない**。
調査の結果、素直な実装には落とし穴があるため:

- `--permission-prompt-tool` は **自動承認された呼び出しを素通しする**
  （allow rule / `acceptEdits` / safe-command判定に当たったものはMCPサーバに届かない）
- すべてのtool callを確実に捕捉するには **PreToolUse hook** が必要

したがって完全な承認ゲートは次の構成になる（次段の作業）:

```text
Sandbox: PreToolUse hook ──HTTPS──▶ Worker /acp/internal/permission (long-poll)
                                        │
                                        ▼  SSE
                                    session/request_permission → editor
                                        │
                                        ▼  JSON-RPC response
                                    hookへ decision を返す
```

現状は `--permission-mode bypassPermissions` で走り、**tool callは可視化されるが承認は求めない**。

### 使い方

```bash
# 動作確認（生のHTTP）
curl -X POST $URL/acp/sessions -H "authorization: Bearer $TOKEN"
# → {"sessionId":"s-...","protocolVersion":1}

curl -N "$URL/acp/sessions/<id>/stream" -H "authorization: Bearer $TOKEN"   # 別端末でSSE購読
curl -X POST "$URL/acp/sessions/<id>/prompt" -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"text":"READMEを読んで要約して"}'
```

エディタ（Zed）から使う場合は、ACP agentとして次を登録する:

```jsonc
{
  "agent_servers": {
    "Remote Claude": {
      "command": "node",
      "args": ["/absolute/path/to/spindle/cli/acp-bridge.mjs"]
    }
  }
}
```

### HTTP API

| Method | Path | 説明 |
|---|---|---|
| `POST` | `/acp/sessions` | セッションID発行 |
| `GET` | `/acp/sessions/:id/stream?since=N` | SSE。`since`で再接続時の取りこぼしを回復 |
| `POST` | `/acp/sessions/:id/prompt` | `{"text":"..."}` |
| `POST` | `/acp/sessions/:id/cancel` | 実行中ターンの中断 |
| `DELETE` | `/acp/sessions/:id` | セッション終了＋Sandbox破棄 |

セッションごとに Durable Object 1つ + Sandbox 1つ。`DELETE` を呼ばなくても
`SANDBOX_SLEEP_AFTER` でidleに落ちるが、**明示的に閉じたほうが安い**。

### 制約

- Sandbox SDKの `exec` は `stdin` を文字列でしか受け取れないため、claudeの常駐プロセスは張れない。
  ターンごとに `--resume` で再入している
- Sandboxがsleepして作業ツリーが失われると `--resume` が効かない（新規セッション扱いになる）
- 1セッションあたり保持するupdateは10,000件まで
- `session/prompt` は1ターンずつ。実行中の追加送信は拒否する
