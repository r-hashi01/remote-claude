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
