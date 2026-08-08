# 0002. Credential をコンテナに一切入れない

- Status: Accepted
- Date: 2026-08-07

## Context

この環境は個人の Claude サブスクリプション（Pro/Max）で動かす。Anthropic API Key は
使わない。理由は課金方式の話だけでなく、**サブスクリプション認証情報を第三者の
リクエスト処理に使ってはならない**という利用上の制約があるため。

同時に、コンテナ内では Claude Code が任意のコードを実行する。つまり
**コンテナ内に置いた秘密は、実行されるコードから読める前提**で設計する必要がある。

## Decision

実 credential をコンテナに渡さない。

1. コンテナ内の `claude` には `CLAUDE_CODE_OAUTH_TOKEN=proxy-injected` という
   センチネル値だけを渡す
2. Sandbox の外向き通信を `interceptHttps` で捕捉し、Workers ランタイム側
   （＝コンテナ外）の `outboundByHost` ハンドラで実トークンに差し替える
3. GitHub App の installation token も同じ経路で注入する。**clone URL に埋め込まない**

API Key へのフォールバックは3重に塞ぐ。

- ハンドラで `x-api-key` を**無条件に削除**し、必ず Bearer を設定する
- 全コマンドで `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` を unset
- 各ジョブが `printenv` でコンテナ内を実測し、存在したら**ジョブを中止する**

## Alternatives

**env var で実トークンを渡す**（当初の要望はこれだった）。単純だが、コンテナ内の
任意コードから読める。`CLAUDE_AUTH_MODE=direct` として退避用に残してあるが既定にしない。

**API Key を使う**。制約により不可。

## Consequences

- 実トークンは Sandbox の filesystem・プロセス環境・Docker image・R2 backup・logs の
  どこにも存在しない
- `git remote -v` や `.git/config` にトークンが出ない
- 代償として、**clone は Worker 側でしか行えない**。コンテナ内のコードが自力で
  リポジトリを取得することはできない
- 同じ理由で、コンテナ側の redaction は**パターンベースに限られる**。既知の値を
  知らないため。Worker 側で値ベースを重ねて二層にしている（0004 参照）
