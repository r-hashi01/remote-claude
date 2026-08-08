# 0004. パイプラインを Durable Object ではなくコンテナ内で実行する

- Status: Accepted
- Date: 2026-08-08

## Context

パイプライン（clone / install / claude / checks / commit / diff）は Durable Object から
ステップごとに `sandbox.exec` を await する形で実行していた。

実測した事実:

| ジョブ | 実行時間 | 結果 |
|---|---|---|
| adc2a5e7 | 51.5秒 | completed |
| 1ef58a0a / 8733ce9d / b962a929 | 51秒超 | **failed** |

失敗した3件はいずれも `sandbox_runs.status = running` / `ended_at = null` のまま、
つまり `execute()` の `finally` に到達していない。

Cloudflare の仕様:

> Each incoming HTTP request or WebSocket message resets the remaining available
> CPU time to **30 seconds**.
> consuming more than 30 seconds of CPU between incoming requests increases the
> heightened chance that the individual Durable Object is **evicted and reset**.

`limits.cpu_ms` を documented maximum の5分に上げても解消しなかった。CLI が1.5秒間隔で
polling していても効かない。**リクエスト側のタイマーがリセットされるだけで、背景処理には
効かない**ため。

そもそも `waitUntil` が Durable Object の寿命を延ばすかどうか、公式ドキュメントは
明言していない。数分かかる処理を DO の背景タスクとして走らせるのは、
プラットフォームの想定外の使い方だった。

## Decision

パイプライン本体を **コンテナ内の Node スクリプト** (`container/runner.mjs`) へ移す。
Durable Object の役割は「起動・ポーリング・ログ中継・成果物の回収」に限定する。

コンテナは長時間実行のために設計されている。DO はされていない。

受け渡しは Sandbox 上のファイルで行う（`$STATE_DIR` 配下）。

```
job.json      Worker が書く入力
log.ndjson    append-only。1行1イベント
status.json   現在のフェーズ
result.json   完了時に一度だけ
patch.diff    完了時に一度だけ
```

## Alternatives

**シェルスクリプトをコンテナに流し込む。** 単純だが、パイプラインには redaction・
ステップ管理・エラー分類のロジックがある。bash に移すと**既存の型とテストを失う**。
言語が TypeScript と bash に分裂する保守コストも払い続けることになる。

**`limits.cpu_ms` を上げるだけで済ませる。** 試したが解消しなかった。仮に効いたとしても
5分が上限で、天井が遠くなるだけで消えない。

**ジョブを短く保つよう利用者に強いる。** 開発基盤としての価値が下がる。

## Consequences

- 5分を超えるジョブが扱えるようになる（本 ADR の完了条件）
- DO の CPU 負荷が激減する。チャンクごとの redaction と SQL 書き込みが消えるため
- ステップ間の往復がなくなり、実行そのものも速くなる
- 代償として、**状態がファイル経由になる**。Worker とコンテナの間に
  「契約としてのファイル形式」が生まれ、両側で守る必要がある
- **redaction が二層になる**。コンテナ側は既知の秘密値を知らない（0002）ので
  パターンベースのみ。Worker 側が読み出す際に値ベースを重ねる。
  独立した二層になる点はむしろ利点
- clone は Worker 側に残る。credential 注入がコンテナ外で必要なため（0002）
- ポーリング間隔ぶんのレイテンシがログに乗る
