# 0001. Cloudflare Sandbox を採用し、Provider 抽象の背後に置く

- Status: Accepted
- Date: 2026-08-07

## Context

ローカル Mac の CPU・メモリ消費を減らすため、Claude Code の実行を隔離された
リモート Linux 環境へ移したい。同時に「Sandbox 基盤を自前実装しない」という制約がある。

## Decision

Cloudflare Sandbox SDK を採用する。ただし**実行系のコードから SDK を直接触らせない**。
`SandboxProvider` / `SandboxSession` を挟む。

```
create / exec / cloneRepository / writeFile / readFile
killAll / snapshot / restore / pause / resume / destroy
```

実行系で `@cloudflare/sandbox` を import してよいのは `providers/cloudflare.ts` だけ。
Durable Object クラス定義と `ContainerProxy` の再 export は deployment 配線なので例外。

## Alternatives

**SDK を直接呼ぶ。** 短期的には速いが、参照箇所が3ファイルに散った時点で
2つ目の provider を足すのが「追加」ではなく「書き換え」になっていた。抽象は
参照箇所が少ないうちに切るのが安い。

**AWS / Kubernetes 等。** 制約により除外。

## Consequences

- 2つ目の provider は1ファイルの追加で済む
- `pause` / `resume` は Cloudflare に同期的 suspend が無いため、`sleepAfter` /
  `keepAlive` への**正直なマッピング**にしてコメントに明記した。抽象が嘘をつかないことを優先
- snapshot ハンドルは不透明な `SnapshotRef` として扱い、呼び出し側は中身を解釈しない
