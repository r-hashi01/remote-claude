# 0014. credential は2種類、ただし同時に1つ

- Status: Accepted
- Date: 2026-08-14

## Context

これまで executor が認証に使える credential は subscription の OAuth token
（`claude setup-token`）だけだった。理由は 0002（credential をコンテナに入れない）と
0013（executor はデプロイした本人のもの）で、後者は「他人のために経路に立つな」という
判断である。

その 0013 が同時に指していたのが **API key** だった。Anthropic の
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) は、
プロダクトを作る側は "API key authentication through Claude Console" を使うべき、
と名指ししている。つまり 0013 は「subscription でやってはいけないこと」を書きながら、
**その代わりに何を使うのか**を実装していなかった。0013 の結論は「やらない」で正しく、
やる場合の道が無いままだった。

具体的に詰まるのは次の3つで、どれも subscription では解けない。

- 人が端末の前にいない実行（cron、CI、bot からの投入）
- 自分以外がプロンプトを送る構成
- ジョブごとにモデルを選びたい要求。subscription では「Claude Code の既定」以外を
  選ぶ意味が薄いが、per-token 課金では**モデルの選択がコストそのもの**になる

加えて、既存のコードには「API key は誤りである」という前提が3箇所に埋め込まれていた。
outbound handler が `x-api-key` を無条件で削り、`claudeProcessEnvironment` が
`ANTHROPIC_API_KEY` を必ず unset し、runner の `verify-environment` がその不在を
検証する。これは 0002 の意図どおりの三重化だが、**方向が片側に固定されていた**。

## Decision

**credential は subscription OAuth token か Claude API key のどちらか1つ。
どちらを使うかは「どちらの secret が入っているか」で決まり、選択用のフラグは作らない。**

- `CLAUDE_CODE_OAUTH_TOKEN` だけ → subscription scheme
- `ANTHROPIC_API_KEY` だけ → api-key scheme
- **両方 → 拒否**。どちらの口座が払うのかが未決だから、推測しない
- どちらも無い → 拒否。メッセージに両方の設定手順を書く

三重の防御は残し、**向きを scheme から導く**ようにした（`foreignCredentialVariables`）。
subscription なら `ANTHROPIC_API_KEY` を、api-key なら `CLAUDE_CODE_OAUTH_TOKEN` を
消して不在を検証する。どちらの取り違えも「動いてしまう」失敗であり、片方だけ守るのでは
守っていることにならない。

モデルは別軸として `CLAUDE_MODEL`（デプロイの既定）と job ごとの `model` /
`--model` を足した。executor は**モデル名の一覧を持たない**。一覧はモデルが出た週に
古くなり、「知らない名前だから拒否する」は最悪の挙動になる。形（名前らしいか）だけを
見て、意味は Anthropic に答えさせる。

## Alternatives

**`CLAUDE_AUTH_SCHEME` のようなフラグで選ぶ。** 採らなかった。フラグと secret は
食い違い、食い違ったときの症状は「間違った credential で署名されたリクエスト」で、
返ってくる 401 はフラグについて何も言わない。同じ理由で workspace bucket にも
フラグを置いていない（`Env` の `BACKUP_BUCKET` のコメント）。**どちらが入っているかが
選択そのもの**にしておけば、食い違う余地が構造的に無い。

**両方入っていたら優先順位で解決する。** 採らなかった。安い方・先に入れた方・
新しい方——どれも「他人の金の出どころ」についての推測である。ここで静かに選ぶと、
月末の請求が説明のつかない形で現れる。落ちるほうがよい。

**API key をリクエストで受け取れるようにする。** 採らない。これは 0013 が名指しした
構造そのもので、`conventions.test.ts` の「nothing a caller sends can carry a
credential」が落ちる。この ADR は**デプロイ側が持つ credential の種類**を増やした
だけで、credential の**出どころ**は変えていない。

**ANTHROPIC_BASE_URL を開けて Bedrock / Vertex も通す。** 今回はやらない。
allowlist と outbound handler の設計に踏み込むし、要求も出ていない。必要になったら
別の ADR で。

## Consequences

良くなること。人が見ていない実行と、自分以外が使う構成に、規約に沿った道ができた。
0013 は「subscription ではやらない」で変わらず、その隣に選択肢が並んだ。
モデルを選べるようになったので、機械的な仕事を小さいモデルに落とせる。

悪くなること。**コストの性質が変わる**。subscription は定額で、その前提で
`MAX_CONCURRENCY` や `JOB_TIMEOUT_MS` の既定値が「安全側」に見えていた。API key では
無人ループが誰も見ていないところで請求を伸ばす。executor は上限を強制できない
（Console の spend limit が唯一の栓）ので、`docs/operating.md` の Cost にそう書いた。

見直す条件。scheme が3つ目を持つとき（Bedrock / Vertex / 自前 gateway）。そのときは
「secret の有無で決める」が破れる——base URL とリージョンが増え、credential の有無だけでは
決まらなくなる。そこが来たらフラグを入れる判断を、この ADR を Superseded にして書く。
