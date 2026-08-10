# 0008. 実行層を4層に分け、内側2層をテストで固定する

- Status: Accepted
- Date: 2026-08-10

## Context

`src/job-manager.ts` が1092行あり、そこに以下が同居していた。

- ジョブの状態遷移（`queued → starting → running → 終了`、二重settleの防止）
- 生存判定（心拍90秒・無出力8分・全体timeout）と、その3つの優先順位
- 起動失敗の再試行可否（「プラットフォームが混んでいた」か「このジョブが壊れている」か）
- DO SQLite のスキーマと移行の履歴、bound parameter の上限に合わせたchunk分割
- R2のキー、Sandbox SDKの呼び出し、alarm の再設定

**このうちテストがあったのは1つも無かった。** テストは `src/acp.test.ts` の翻訳層だけで、
それは唯一 platform を必要としない純粋関数だったから書けていた。

そして検証したいことは、まさに書かれていない側にあった。ADR 0005〜0007 で訂正した不具合は
すべてここに属する — 「stall と death を取り違えない」「mirror前のsnapshotで生存判定しない」
「settleを二度しない」。どれも**timestampの引き算**でしかないのに、確かめるには
container と workerd を起動し、しかも**失敗を意図的に起こす手段が無かった**。

## Decision

4層に分ける。依存の矢印は内向きだけ。

```text
interface/       HTTPを受けてJSONを返す。何も判断しない
application/     ユースケース。ポート越しに書かれている
domain/          規則。何もimportしない
infrastructure/  ポートの実装（DO / SQLite / R2 / GitHub / Sandbox SDK）
```

- 判断は `domain` に移した。`Job` 集約が遷移を持ち、`health.ts` が3つの判定を持ち、
  `retry.ts` が再試行可否を持ち、`repository.ts` / `branch.ts` / `prompt.ts` が入力の規則を持つ
- 手順は `application/job-service.ts` に移した。外界は `application/ports` の interface としてだけ見える
- `job-manager.ts` は解体した。`JobManager` は残っているが**ポートを組み立ててRPCを翻訳するだけの
  adapter** で、SQLは `infrastructure/persistence` に閉じた
- テストランナーは vitest。`application/testing.ts` が全ポートのインメモリ実装を持ち、
  ジョブの一生（受付・起動・mirror・stall・cancel・settle・回収）を**Mapに対する算術として**回す

DO のクラス名は変えない。`wrangler.jsonc` の migrations はクラス名で紐づいており、
storage を落とさずに改名する方法が無い。

## Alternatives

**そのままテストを足す。** `@cloudflare/vitest-pool-workers` で DO を起動すれば
書けはする。だが「心拍が来ない」「clone が失敗する」「platform が混んでいる」を
**意図的に起こす手段が無い**という問題は残る。判断がI/Oと同じ関数の中にある限り、
テストの容易さはランナーでは解決しない。

**ファイルを分けるだけにする。** 1092行を5つに割っても、呼び出し関係が同じなら
テスト可能性は上がらない。分割の価値は行数ではなく**依存の向き**にあった。

**timeout値を env var にする。** 設定可能にすれば実験しやすいと考えたが、これは
deployment ごとに変える値ではなく runner の報告の仕方の性質なので、`domain` の定数に置いた。

## Consequences

- 146個のテストが 0.5 秒で走る。ネットワークもworkerdも使わない
- 最初のテストを書いた時点で、既存の挙動のうち**言葉にされていなかった規則**が出てきた:
  「requeue は startedAt と logSeq を捨てる」「settle済みのjobは二度settleしない」
  「keep は inspection のためのkeepであって永久ではない」。どれもコードにはあったが
  条件式として散っていた
- 代償として、1つのジョブの流れを追うのに3つの層をまたぐ。`JobService` は約400行で、
  次に大きくなったらユースケース単位（create / launch / poll / sweep）に割る
- `src/domain` が platform型を1つでもimportし始めたら、この分割は崩れている。
  `Env` は `infrastructure/env.ts` にしか無い

## 教訓

**テストが書かれていない場所は、たいてい「書けなかった場所」であって「不要な場所」ではない。**
このリポジトリで訂正が3回起きた場所と、テストが1つも無かった場所は、完全に一致していた。
