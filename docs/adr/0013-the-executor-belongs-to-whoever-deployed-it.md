# 0013. executorは、デプロイした本人のもの

- Status: Accepted
- Date: 2026-08-14

## Context

このリポジトリを公開して人を呼び込んでよいかを点検する過程で、Claude Code の
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) に
この構造を名指しする条項があることが分かった。

> **OAuth authentication** is intended exclusively for purchasers of Claude Free,
> Pro, Max, Team, and Enterprise subscription plans and is designed to support
> ordinary use of Claude Code and other native Anthropic applications.
>
> **Developers** building products or services that interact with Claude's
> capabilities ... should use API key authentication through Claude Console or a
> supported cloud provider. Anthropic does not permit third-party developers to
> offer Claude.ai login or to route requests through Free, Pro, or Max plan
> credentials on behalf of their users.

検討中に、**妥当に見えて外れている読み方が2つ**出た。両方とも記録に値する。
どちらも「言われれば分かる」ものではなく、実際にその場で正しく見えたものだから。

**1つ目「ユーザーごとに credential を持ち寄り、ユーザーごとに sandbox を立てれば良い」。**
サンドボックスは1人1つ、他人は覗けず、誰も他人の Claude Code を使わない。
Consumer Terms の「自分のアカウントを他人に使わせない」は確かに満たす。
しかし上の条項が判定しているのは credential が誰のものかではなく、
**プロダクトが経路に立って自分のユーザーのためにリクエストを流すかどうか**であり、
この構成はそれに当たる。加えて credential を受け取る導線は前半の
"offer Claude.ai login" に直接あたる。

**2つ目「どのクラウドアカウントに立っているかが実質を決める」。**
これも外れている。自分で契約した EC2 に Claude Code を入れて自分で使うのは
ただの ordinary use であり、Cloudflare も AWS も計算資源を売っているだけで
credential の経路の当事者ではない。アカウントの所有は運用者を推測する手がかりには
なるが、判定そのものではない。

なお spindle は現時点で作者ひとりが使うもので、複数ユーザーの実装は無い。
これは将来の実装の前に、**先に決めておく**ための記録である。

## Decision

**executor は、デプロイした本人の道具とする。** 借りた VM で Claude Code を動かすのと
区別がつかないものであり続ける。

- executor は**呼び出し側から credential を受け取らない**。どの要求型にもその
  フィールドを置かない。`src/conventions.test.ts` が、追加されたら落ちる
- この上に作る製品（spindle）は、**人と、その人自身の credential の間に立たない**。
  他人がデプロイした executor に対して話しかけるだけで、持つとしても
  その executor の bearer token までとする
- 複数人に提供する日が来たら、各自が**自分の executor を持ち込む**。
  各自が自分のサブスクリプション credential を持ち寄る形は採らない
- 計算資源を呼ぶかどうかは**利用者が決める**。意思なく起動する動線は作らない

credential の**保管場所**はこの ADR の対象ではない。現在は Worker の secret だが、
将来 env から抜く想定がある。決めたのは「リクエスト経由では来ない」の一点であり、
保管方法が変わってもこの決定は生き残る。

## Alternatives

**ユーザーごとのサブスクリプション credential。** 上記の通り、条項が名指しで
拒否している構成そのもの。見た目が clean なだけに、記録しておかないと再発する。

**API key（Commercial Terms）— 持ち込み、またはプラットフォーム保有。**
規約上は**認められている**。むしろ「プロダクトを作るなら」と名指しで推奨されている
経路であり、複数ユーザーに提供する正規の道はこちらである。採らなかった理由は規約ではなく2つ:

1. 定額サブスクリプションで動くという性質が消える。従量課金が利用者か運営者の
   どちらかに乗る。それは remote-claude の価値のかなりの部分だった
2. executor は現在 API key を**3方向から拒否している**（outbound で `x-api-key` を剥ぎ、
   全コマンドで環境変数を unset し、各ジョブが実行前に不在を証明する）。
   これは意図的な防御であり、戻すのは小さな変更ではない

オンボーディングの重さが理由で shape A が成立しないと分かった場合、
**正直な次の一手はこれ**である。その判断は事業の判断であって技術の判断ではない。

**1つのデプロイを共有し、1つの credential で複数人に使わせる。** 条項の中心そのもの。

## Consequences

**オンボーディングが代償になる。** executor 1台に secret 5本（workspace を使うなら8本）、
GitHub App の作成、PKCS#1 から PKCS#8 への変換、Cloudflare アカウントと `wrangler deploy`。
技術者でも30分仕事で、`openssl` の行で人が落ちる。複数ユーザーに進む日が来るなら、
**投資すべきはここ**であって機能ではない。

**削るなら GitHub 側から。** Claude credential は規約上ユーザーの手元から動かせないが、
GitHub credential にその制約は無い。公開 GitHub App を1つ出せば作成・鍵生成・変換の
3ステップが消える。代償は installation token の発行経路に製品が立つこと — つまり
**利用者のリポジトリへの権限を握る**ことであり、要求される信頼の水準が上がる。

**これは条文の読解であって、Anthropic の見解ではない。** 事業として確定させる段階では
[contact sales](https://www.anthropic.com/contact-sales) で裏を取ること。
特に「executor は利用者のもので、製品は経路に立たない」という構成が
向こうから見ても同じに見えるかは、こちらでは答えられない。
