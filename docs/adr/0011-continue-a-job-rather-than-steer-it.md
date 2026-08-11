# 0011. ジョブは「操縦」せず「続ける」。そのために workspace を持ち越す

- Status: Accepted
- Date: 2026-08-11

## Context

roadmap RC-7（対話的ステアリング）に、**実データが出た。**

spindle の実装タスクを投げたところ、agent は依頼を MVP scope の項目と同定し、
**その repo には HTTP レイヤーが無く、remote-claude の API 契約が1行しか手元に無い**ことを
突き止めたうえで、こう返して止まった:

> `JobClient` interface を注入する形で domain だけ組むか、それとも実際の API 契約をくれれば
> 本物のクライアントを書くか — どちらにしますか

**一発勝負のジョブが「質問」を返した。** これは失敗ではなく、正しい停止の仕方だった。
足りないのは agent の能力ではなく、**答えを返す経路**だった。

## Decision

**実行中に割り込むのではなく、終わったジョブを続ける。**

Claude Code の非対話実行は途中で入力を受け取れない（`claude -p` は一発）。そして観測された
必要性は「途中で方針を変える」ではなく「**質問に答えて次を走らせる**」だった。だから

    POST /jobs/:id/continue { prompt }

が答えで、これは新しいジョブとして走り、**同じ会話と同じ作業ツリーを引き継ぐ**。

続けるには2つが生き残っている必要がある。

1. **作業ツリー** — 前のターンが書いた変更
2. **会話** — Claude Code 自身のセッション。`--resume <id>` で再開する

Claude Code は会話を **HOME 側**（`~/.claude/projects/<cwd をスラグ化したもの>/`）に置くので、
既定のままでは「持ち越せる1つのディレクトリ」の外にある。**`CLAUDE_CONFIG_DIR` を
`/workspace/.claude` に向ける**ことで、会話がツリーの隣に来て、**snapshot 1つで両方運べる。**

コンテナの作業ディレクトリは常に `/workspace/repo` なので、**スラグは別の sandbox でも一致する。**
これは偶然ではなく、パスを固定してあることの配当。

### 持ち越し方: container を抱えるのではなく snapshot する

継続のあいだ container を生かしておく手もあるが、`max_instances` は3で、
**「返事待ち」が同時実行枠を食う**のは割に合わない。ジョブが終わったら workspace を R2 へ
snapshot し、続けるときに新しい sandbox へ restore する。

**これは RC-10（workspace cache）そのものだが、速度のための最適化ではなく継続の仕組みとして要る。**
設定できて呼ばれない状態が長く続いたのは、それを必要とする機能が無かったからでもある。

## Alternatives

**セッション（ACP）をジョブ経路に繋ぐ。** ACP セッションは既に多ターンで `--resume` も使う。
だがセッションには pipeline（install/lint/test/commit/push）が無く、**成果物を出す経路が無い**。
「質問に答えたら、検証してPRまで出す」ためには pipeline 側に会話を持たせるほうが近い。
ACP は editor から人が操縦するための面として残す。

**`keepSandbox` を延長して container を保持する。** 同時実行枠を返事待ちに使う。
30分の grace はすでにあるが、それは「調べるため」であって「続けるため」ではない。

**会話を持ち越さず、前のターンの diff と質問だけを新しいプロンプトに貼る。**
実装は最も簡単で、**agent に自分が見ていない会話を再構成させる**ことになる。
今日の観測（agent は repo の構造を調べ直して結論に至っていた）からして、その調査を捨てる。

## Consequences

- 続けるジョブは**新しいジョブとして記録される**。履歴・usage・steps がターンごとに残る
- `claudeSessionId` を記録するようになった。**毎回届いていて捨てていた値**で、
  これが無いと再開できない
- `CLAUDE_CONFIG_DIR` は container 固有の値。`scripts/run-locally.mjs` はこれだけ適用しない
  — ローカルではそこに開発者の認証情報があり、移すとログアウトする（実際に踏んだ）
- snapshot/restore が**ジョブ経路の一部になる**。失敗は致命ではない（restore できなければ
  fresh clone へ落ちる）が、**継続を要求したジョブが restore に失敗したら、それは失敗**
- 会話が `/workspace/.claude` にあるということは、**snapshot に会話が入る**。
  R2 に何が置かれるかが変わるので、保持期間と redaction の対象として扱う

## 教訓（先取り）

**「設定できるが呼ばれない」ものは、それを必要とする機能が来たときに初めて正しい形が分かる。**
workspace cache を「速度のため」に配線していたら、会話を含める設計にはならなかった。

## 追記 (2026-08-11) — 最初の継続で分かった2つの事実

**実際に継続を試したら `kept no workspace` で拒否された。** バケットは bind してあったので、
snapshot が失敗していた。そして**失敗した理由はどこにも残っていなかった** — provider が
「snapshot は最適化だから」と例外を飲んでいた。この ADR がそれを最適化ではなくしたのに、
そのコメントと実装は変わっていなかった。**依存の向きが変わったとき、飲んでいた例外は毒になる。**

分かった事実を2つ記録する。

1. **presigned upload に4つ要る。** バインディングだけでは足りない（Sandbox SDK は container から
   presigned URL で直接 R2 へ上げる）。`BACKUP_BUCKET`（binding）+ `BACKUP_BUCKET_NAME`（var）+
   `CLOUDFLARE_ACCOUNT_ID` + `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`。
   **2つだと思って2つ入れ、まだ足りなかった。** エラーは4つ全部を名指ししていて、
   それが読めたのは例外を飲むのをやめた直後だった。

   そして足りなかった2つは、**直前の棚卸しで「宣言されているが誰も読まない」と印を付けた**
   `CLOUDFLARE_ACCOUNT_ID` と `BACKUP_BUCKET_NAME` だった。読んでいたのは SDK 側。
   **「誰も読まない」は「このリポジトリの中では読まない」だった。**

2. **`gitignore` オプションは、対象ディレクトリが git repo の中にある場合だけ効く。**
   `/workspace` は repo ではない（repo は `/workspace/repo`）ので、
   **`node_modules` は除外されていなかった。** `excludes: ['node_modules']` で名指しに変えた。
   「git に聞けばいい」は、git が答えられる場所にいるときだけ正しい。

3. **restore は永続展開ではなく FUSE overlay マウント。** SDK のドキュメントいわく
   「マウントは container が動いているあいだだけ持続し、sandbox が sleep すると失われる」。
   継続ジョブは restore 直後に pipeline を走らせ、終わったら再 snapshot するので成立するが、
   **継続ターンの最中に container が sleep したら workspace は消える。**
   2秒ごとの poll が活動として効いているが、これは前提であって保証ではない。

## 追記2 (2026-08-11) — 3回目と4回目

継続を通すまでに、ジョブを4本使った。**毎回エラーが1段深くなった**のが記録として価値がある。

| 回 | 出たもの | 実際に足りなかったもの |
|---|---|---|
| 1 | `kept no workspace`（拒否は 500）| snapshot が失敗していたが**理由が飲まれていた** |
| 2 | `Missing: ...` 4つ全部 | 4つ必要だと分かった（2つだと書いていた）|
| 3 | `Missing: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY` | secret は**存在するが空**だった |
| 4 | `Presigned URL upload failed: curl (22) 520` | **許可リストに R2 のエンドポイントが無かった** |

4回目が示したのは、**ある機能を有効にすると、別の判断が閉じた穴を開ける必要が出る**ということ。
container のネットワークは deny-by-default（ADR 0002 の姿勢）で、workspace の持ち越しは
その中から自分の R2 へ上げる。設定項目を1つ増やす選択もあったが、**導出した** —
「workspace を保持する deployment は自分の R2 に到達できなければならない」は設定ではなく事実。

`CLOUDFLARE_ACCOUNT_ID` があるとき `<account>.r2.cloudflarestorage.com` を許可リストに加える。
明示的に R2 ホストが書かれていれば触らない。

3回目の教訓も書いておく: **`wrangler secret put` は空入力でも成功と表示する。**
そして SDK 側は `!value` で判定するので、**空の secret は未設定と完全に同じに見える。**
今日3度目の「値が存在するが効かない」だった（`ALLOW_PUSH`、`WORKSPACE_CACHE`、そして空 secret）。
