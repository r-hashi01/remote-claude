# 0007. runner をイメージではなく Worker と一緒に配る

- Status: Accepted
- Date: 2026-08-08

## Context

`container/runner.mjs` は Dockerfile の `COPY` でイメージに焼き込んでいた。
つまり **Worker とコンテナイメージという2つの成果物が一致している必要がある**のに、
それを保証する仕組みが無かった。

実際にドリフトした。runner に心拍を追加し、Worker 側に「90秒心拍が無ければ死亡とみなす」
検知を入れて deploy したところ、

```
#8 [4/5] COPY container/runner.mjs /opt/remote-claude/runner.mjs
#8 CACHED
Image already exists remotely, skipping push
```

**古い runner がコンテナに残ったまま、Worker だけが新しい前提で動いた。**
心拍を打たない runner に対して心拍を待つので、90秒を超えるフェーズがあれば必ず
偽陽性で殺される。Dockerfile を変更しても push はスキップされ続けた。

症状は「runner が応答しない」という誤った診断として現れ、原因追及に時間を要した。

## Decision

イメージへの焼き込みをやめる。**Worker がジョブ開始時に runner を Sandbox へ書き込む。**

`scripts/embed-runner.mjs` が `container/runner.mjs` を文字列として
`src/runner-source.ts` に埋め込み、Worker バンドルの一部として配送される。
`predeploy` / `pretypecheck` で自動実行する。

runner は 11KB。ジョブごとに書いても無視できる。

## Alternatives

**wrangler のキャッシュ問題を追う。** 原因を特定できても、
「2つの成果物が一致している必要がある」構造は残る。**検知ではなく除去**を選んだ。

**イメージのタグにコンテンツハッシュを含める。** Dockerfile にハッシュを埋める試みは
効かなかった。仮に効いても、同期を人間の手順に依存させる形は変わらない。

## Consequences

- **Worker と runner が食い違うことが原理的に起きなくなる。** 成果物が1つになったため
- runner の変更に**イメージ再ビルドが不要**になり、反復が速くなる
- 生成ファイル `src/runner-source.ts` はコミットする。deploy 時に生成手順を
  踏み忘れても壊れないようにするため（→ **後述の訂正で撤回**）
- 代償として、runner のサイズが Worker バンドルに乗る。11KB なので現状は問題にならないが、
  肥大化したら再考する

## 訂正 (2026-08-08)

上の Consequences のうち **「生成ファイルをコミットする」を撤回する。**

この決定は同じ日にそのまま裏目に出た。`--output-format stream-json` 対応で
runner を書き換えたが、`predeploy` フックは `npx wrangler deploy` を直接叩けば
発火しない。deploy は**ディスク上の古い `src/runner-source.ts` をそのまま出荷し**、
Worker だけが agent イベントを待つ状態になった。

症状は「進捗行とトークン消費量が出ない」。翻訳層 (`src/acp.ts`) の不具合として
数時間追ったが、実際には**翻訳すべきイベントが最初から1つも生まれていなかった**。
記録された `result.claudeOutput` が NDJSON ではなく平文だったことが決め手で、
それは最初から手元にあった。

二重の対策を入れた。

1. 生成を `wrangler.jsonc` の `build.command` に移した。npm スクリプトと違い、
   **`wrangler deploy` を直接叩いても迂回できない**
2. `src/runner-source.ts` を `.gitignore` に入れた。コミットされた生成物は
   「独立に編集できる runner の2つ目のコピー」であり、
   このADRが除去したはずのドリフトそのものだった。実際に stale なまま
   コミットされており、次に読む人を誤診させる材料になっていた

代償: clone 直後は生成ファイルが存在せず、`tsc` を直接叩くと解決できない import になる。
`npm run typecheck` (`pretypecheck`) と `wrangler deploy`/`dev` は必ず生成するので、
実際の経路はすべて通る。

## 教訓

**「2つの成果物が一致していなければならない」という制約は、それ自体が欠陥。**
一致を検証する仕組みを足すより、成果物を1つにできないかを先に問うべきだった。

そして訂正のぶんを足すなら —
**「迂回できる強制」は強制ではない。** どの経路から叩いても通る場所に置くまで、
成果物が1つになったとは言えない。

**症状を観測した対象が、いま書いているコードと同じものか。** それを確かめる前に
原因を探し始めると、正しいコードを何時間でも疑える。
