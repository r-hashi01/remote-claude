# 0009. client を同じリポジトリの公開パッケージとして出す

- Status: Accepted
- Date: 2026-08-10

## Context

利用者から届いたフィードバックの1つ目:

> **SDK が無い。** 各利用者が HTTP を手書きすることになります。
> client.ts をそのまま持っていける形にしてあります

実際に spindle 側の `apps/web/app/remote-claude/client.ts` には、こう書かれていた。

> remote-claude はそれ自体で公開されている実行基盤で、Spindle はその1利用者にすぎない。
> 次にこの上に作られるものが、このファイルを書き直す必要はないはずだ。
> **このファイルはあちらのリポジトリに属する**が、こちらからあちらへ publish できないので
> ここに置いてある。

APIには利用者が自分で発見しないと分からない癖があった。

- `POST /jobs` のレスポンスだけ id を `jobId` と呼ぶ。他のendpointは `id`
- `GET /jobs` は配列を `tasks` という名前で返す（jobに改名する前の名残）
- `GET /jobs/:id/diff` は差分が無いとき `404` を返す。これはエラーではない
- エラーは `{"error": "..."}` に包まれている

## Decision

`sdk/` を独立した npm package として持つ。`@r-hashi01/remote-claude-client`。

- **型は SDK 側で再宣言する。** executor の型を直接importすると
  `@cloudflare/workers-types` が利用者に漏れる
- 再宣言した型が本当にAPIと一致していることは `src/sdk-contract.ts` が
  **compile-time に検査する**。「executorが返すもの」が「SDKが約束したもの」を満たしているか、
  「SDKが送れるもの」が「executorが理解するもの」か、statusの集合が両方向で一致しているか
- 上記の癖は SDK が吸収する。`create` は `id` を埋め、`list` は `jobs ?? tasks` を読み、
  `getDiff` は 404 を `null` にし、エラーは封を開けて executor 自身の文言を投げる
- 層は executor と同じ（ADR 0008）。`JobGateway` ポートがあるので、
  polling loop はサーバー無しでテストできる

APIも2つだけ足した。`POST /jobs` が record 全体と `id` を返し（`jobId` も併記して互換を保つ）、
`GET /jobs` が同じ配列を `jobs` と `tasks` の両方で返す。**消さずに足す**ので既存の利用者は壊れない。

## Alternatives

**OpenAPI から生成する。** スキーマという3つ目の成果物が増える。
ADR 0007 の教訓（「2つの成果物が一致していなければならない」という制約自体が欠陥）が
そのまま当てはまる。今は型が2箇所にあるが、**一致は生成ではなく検査で保証**していて、
検査は `npm run typecheck` の一部として必ず走る。

**1ファイルを vendor させる。** いま spindle がやっていること。動くが、
利用者は自分が持っているのがどのバージョンか分からない。

**executor から型を直接 import させる。** platform型が漏れる。
`sdk` が `wrangler` や `@cloudflare/sandbox` に依存することにもなる。

## Consequences

- 契約検査は書いた直後に**実際に1件見つけた**。spindle 側の `JobStatus` に `starting` が
  無く、その状態のジョブは型が合っていなかった
- APIを変えると `npm run typecheck` が落ちる。落ちたら**SDKをAPIに合わせる**のが既定で、
  逆は意図的なAPI変更のときだけ
- publish の手順が増える（`npm run sdk:build` → `npm --prefix sdk publish`）。
  CI は build と typecheck までやるが、publish は手で行う
- 代償として、同じ型が2箇所にある。検査が無ければこれは明確な悪手なので、
  `src/sdk-contract.ts` を消すなら同時に別の保証を用意すること
