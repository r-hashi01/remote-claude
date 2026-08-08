# 0003. 実行基盤とプロダクトをリポジトリごと分離する

- Status: Accepted
- Date: 2026-08-08

## Context

remote-claude（実行基盤）と spindle（プロダクト）が同一コードベースにあり、
**"Task" が2つの別物を指していた**。

| | spindle の Task | remote-claude の Job |
|---|---|---|
| 意味 | Project を前に進める仕事の単位 | 実行1回。prompt を入れて diff を返す |
| 寿命 | 数日。PR・CI・Slack で状態が変わる | 数十秒〜数分 |
| 状態 | to_do / in_progress / ready_for_review / done | queued / running / completed |

この混同の結果、プロダクトのドメイン（Project / Task / Update / Output）を
**汎用であるべき実行層の中に実装してしまった**。

## Decision

リポジトリを分ける。

- **remote-claude** — job だけを扱う。Project を知らない。`POST /jobs` → diff
- **spindle** — Project / Task / Update / Output / Connection。実行が要るとき job API を呼ぶ

`git subtree split` で履歴を保存して移動。Durable Object は `renamed_classes`
マイグレーションで `TaskManager` → `JobManager` にリネームし、既存オブジェクトを引き継いだ。

## Alternatives

**同一リポジトリでディレクトリ分割。** deploy 経路を作り直さずに済むが、
境界が曖昧なままになり、また混ざる。実際に一度混ぜているので、構造で強制するほうを採った。

## Consequences

- remote-claude は spindle 以外からも使える
- 代償として設定ドリフトが発生する。`INSTALL_COMMAND` 等は**対象リポジトリ側のパス**を
  指すため、向こうの構造が変わると壊れる。分割直後に実際に壊れた
- CLI はリポジトリ非依存になり、設定は `~/.config/remote-claude/config.json` が既定
- AGENTS.md に Task/Job の区別を明記した。混同しやすいことが分割の理由そのものなので
