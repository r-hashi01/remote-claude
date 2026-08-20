# Architecture Decision Records

構造に影響する判断を、**決めた時点で**記録する。

## 書く対象

- 差し戻すのに費用がかかる判断
- 他の選択肢が妥当に見えた判断
- あとから読んだ人が「なぜこうなっているのか」と思う判断

逆に、実装の細部や、選択肢が実質1つしかなかったものは書かない。

## 形式

`NNNN-短い題.md`。連番は再利用しない。

```markdown
# NNNN. 題

- Status: Proposed | Accepted | Superseded by NNNN | Reversed
- Date: YYYY-MM-DD

## Context
何が問題で、何が制約だったか。事実と観測を書く。

## Decision
何を決めたか。

## Alternatives
検討して採らなかった選択肢と、採らなかった理由。

## Consequences
良くなること、悪くなること、将来これを見直す条件。
```

## 訂正の扱い

**判断が間違っていたと分かったら、元のADRを書き換えない。**
Status を `Superseded by NNNN` か `Reversed` に変え、新しいADRで経緯を書く。

判断そのものより、**なぜ間違えたか**のほうが後から価値を持つことが多い。
このリポジトリでは既に2回訂正が起きている（0005 を参照）。

## 一覧

各 ADR の Decision の1行要約。**追記で判断が変わったものはそう書く** — 一覧だけ読んで
決定を引用されると、覆った判断が生き続けることになる。

- [0001. Cloudflare Sandbox を採用し、Provider 抽象の背後に置く](0001-cloudflare-sandbox-behind-a-provider-abstraction.md) — Cloudflare Sandbox SDK を採用するが、実行系から直接触らせず `SandboxProvider`/`SandboxSession` という抽象を挟む。
- [0002. Credential をコンテナに一切入れない](0002-no-credentials-inside-the-container.md) — 実 credential はコンテナに渡さず、センチネル値を渡した上で Workers 側の outbound ハンドラで実トークンに差し替え、API Key へのフォールバックを3重に塞ぐ。
- [0003. 実行基盤とプロダクトをリポジトリごと分離する](0003-separate-execution-from-product.md) — remote-claude（job専用）と spindle（Project/Task等）にリポジトリを分離し、履歴は `git subtree split` で移した。
- [0004. パイプラインを Durable Object ではなくコンテナ内で実行する](0004-run-the-pipeline-inside-the-container.md) — パイプライン本体をコンテナ内の `runner.mjs` に移し、Durable Object は起動・ポーリング・ログ中継・回収に限定する。
- [0005. リソースライフサイクルに関する2つの判断の訂正](0005-two-corrections-on-resource-lifecycle.md) — 孤児回収の理由を「コスト」から「資源を確実に回収する責務」に置き換え、Sandbox の割り当て台帳を持ち、台帳自体を巡回の駆動源にする。
- [0006. リトライは runner 起動前に限る](0006-retry-only-before-the-runner-starts.md) — 一過性エラーの自動リトライは runner 起動前の失敗（副作用なし）に限り、起動後は二重実行のリスクがあるためリトライしない。
- [0007. runner をイメージではなく Worker と一緒に配る](0007-ship-the-runner-with-the-worker.md) — runner をイメージに焼き込むのをやめ、Worker がジョブ開始時に Sandbox へ書き込む方式に変更した。
- [0008. 実行層を4層に分け、内側2層をテストで固定する](0008-layer-the-executor.md) — 実行系を interface/application/domain/infrastructure の4層に分け、判断は domain に、手順は application に移し、インメモリ実装でテストできるようにした。
- [0009. client を同じリポジトリの公開パッケージとして出す](0009-ship-the-client-as-a-package.md) — SDK を独立した npm package として持ち、型を再宣言しつつ `sdk-contract.ts` で API との整合を compile-time に検査する。
- [0010. どのrepositoryで走らせられるかは、credentialの到達範囲が答える](0010-the-credential-defines-the-repositories.md) — `ALLOW_CUSTOM_REPO` を既定 true のまま許可リストを持たず、GitHub App installation が到達できる範囲そのものを境界とし、受付時にアクセス可否を確認する。
- [0011. ジョブは「操縦」せず「続ける」。そのために workspace を持ち越す](0011-continue-a-job-rather-than-steer-it.md) — 実行中に割り込むのではなく終わったジョブを続ける仕組みとし、workspace と Claude Code の会話を snapshot して持ち越す。
- [0012. 走っているジョブに2つの見方を用意する](0012-two-views-of-a-running-job.md) — 進行度を答える `getLogs`（行）と、いま何が起きているかを答える出力ストリーム（バイト）という2つの見方を別々に持つ。
- [0013. executorは、デプロイした本人のもの](0013-the-executor-belongs-to-whoever-deployed-it.md) — executor はデプロイした本人の道具とし、呼び出し側から credential を受け取らず、spindle は人と本人の credential の間に立たない。
- [0014. credential は2種類、ただし同時に1つ](0014-two-credentials-one-at-a-time.md) — credential は subscription OAuth token か API key のどちらか1つとし、両方あれば拒否、フラグでの選択は作らない。
- [0015. 入口は1つにする — SDK と CLI](0015-one-way-in.md) — 入口を SDK と CLI の2つだけにし、ダッシュボードと ACP のプロトコル面を削除しつつ、ログ変換に使う `session/update` の語彙は残す。
- [0016. レジストリに毎回聞かない](0016-stop-asking-the-registry.md) — リポジトリごとの npm キャッシュを R2 に持ち越し、鍵は lockfile ハッシュではなくリポジトリとする。**追記で保留**: 実測 193MB が multipart になり通らないため、現在は上限超のアップロードを試みない。
