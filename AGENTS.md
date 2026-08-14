# remote-claude で作業するエージェントへ

このファイルは、このリポジトリを**サンドボックス内で**編集するエージェント（`/delegate` で
投げられたジョブを含む）と、ローカルで作業するエージェントの両方に向けている。

## このリポジトリは何か

ローカルではなく Cloudflare Sandbox 上で Claude Code を実行する基盤。扱うのは **job**
（プロンプトを1本実行して diff を返す）だけで、Project や仕事の継続的な状態は扱わない。
それは呼び出し側（spindle）の責務 — ADR 0003。

## ジョブの結果を見る

投げた本人以外には何が起きたか見えない、というのは情報が無いからではなく、
見に行く場所が書かれていないだけ。

- `remote-claude status <job-id>` — status・usage・コスト・diffstat・lint/test の結果・
  agent の締めの発言
- `remote-claude diff <job-id>` — 差分そのもの
- `remote-claude logs <job-id>` — 全ログ（`-f` で追尾）
- `remote-claude ui` — ローカルのダッシュボード。**トークンを持つマシンからしか開けない**

agent の締めの発言は要約であって監査ではない。実際に何が変わったかは diff にしかない。

## 層（これを壊さないこと）

依存の矢印は**内向きだけ**。ADR 0008。

```text
interface/       HTTPを受けてJSONを返す。何も判断しない
application/     ユースケース。ポート越しに書かれている
domain/          規則。何もimportしない
infrastructure/  ポートの実装 (DO / SQLite / R2 / GitHub / Sandbox SDK)
```

- `src/domain/**` が platform 型を import したら、その変更は間違っている。
  `Env` は `src/infrastructure/env.ts` にしか存在しない
- 新しい外界（キュー、別のストレージ、別のGit provider）が必要になったら、
  まず `src/application/ports/` に interface を足し、実装を `src/infrastructure/` に置く
- 判断（分岐・閾値・「どういうときに何とみなすか」）は `src/domain/` に置く。
  それが `application` に漏れ始めたら、テストできない場所が増えている

## 変更の手順

1. **テストを先に書く。** `src/domain` と `src/application` はネットワークも workerd も
   使わずに走る。ポートのインメモリ実装は `src/application/testing.ts` にある
2. 実装する
3. `npm test` と `npm run typecheck`（テストも型検査の対象）
4. SDK を触ったら `npm run sdk:typecheck` も。API の形を変えたなら
   `src/sdk-contract.ts` が落ちるので、**SDK を API に合わせる**（逆は意図的なAPI変更のときだけ）

```bash
npm test              # vitest — domain / application / sdk
npm run typecheck
npm run sdk:typecheck
```

## 触ってはいけないもの

- **Durable Object のクラス名**（`JobManager` / `Sandbox`）。
  `wrangler.jsonc` の migrations がクラス名で紐づいており、改名は storage を失う。
  `AgentSession` は v4 で削除済み（ADR 0015）— 名前は migrations の履歴に残る
- **`container/runner.mjs` と `job.json` の契約**。片方だけ変えるとコンテナと
  Worker が食い違う。ADR 0007 の失敗はこれ
- **credential をコンテナに渡す形**。実 token は Worker の outbound handler で注入する。
  ADR 0002
- `src/infrastructure/runner-source.ts` は生成物。編集するのは `container/runner.mjs`

## 判断を記録する

構造に影響する判断をしたら `docs/adr/` に足す。書式と方針は `docs/adr/README.md`。
**既存の ADR は書き換えない。** 間違っていたと分かったら Status を変えて新しい ADR を書く。

## サンドボックス内で走っている場合の制約

- **deploy と live 検証はできない。** Cloudflare の credential を意図的に渡していない（ADR 0002）
- ネットワークは deny-by-default。`SANDBOX_ALLOWED_HOSTS` の外へは出られない
- `wrangler` を叩く変更（deploy、secret 登録、R2 操作）は提案までにして、diff に残す
- 途中で方針を変えられない。前提が崩れたら**そこで止めて、何が食い違ったかを書く**。
  推測で進めた実装より、止まった理由のほうが呼び出し側に価値がある
