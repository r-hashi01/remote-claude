# 0010. どのrepositoryで走らせられるかは、credentialの到達範囲が答える

- Status: Accepted
- Date: 2026-08-10

## Context

利用者から届いたフィードバックの2つ目:

> **ALLOW_CUSTOM_REPO が false。** repo を渡すと拒否されます。
> 任意の Project を扱うプロダクトからは必須です。エラー文が「executor 側の設定の話」だと
> 分かるよう、Spindle 側で言い換えています

3つの別々の問題が入っている。

1. 既定が `false` で、複数Projectを扱う製品はそのまま使えない
2. 拒否のメッセージが `custom repositories are disabled` だけで、**受け取った側の
   バグに見える**。実際 spindle は文言を言い換えるコードを持っていた
3. `ALLOW_CUSTOM_REPO` は実装済みだが未検証だった（roadmap RC-8）

そして機能を開けるときに、許可リストを持つべきかという問いが残っていた。

## Decision

`ALLOW_CUSTOM_REPO` の既定を `true` にする。真偽値のまま保ち、**許可リストは持たない。**

境界は **GitHub App installation が到達できる範囲そのもの**とする。ジョブ受付時に
`GET /repos/{owner}/{name}` を installation token で叩き、見えなければ `400` で拒否する。

- URLの形の検査は残す（https / `github.com` / credential埋め込み無し）
- `REPO_URL` と同じrepoを別の書き方で渡した場合は「別repo指定」と扱わない
  （`.git` の有無・末尾スラッシュ・大文字小文字）
- 拒否の文言には**両方のrepo名**と、それが executor 側の設定であることを書く
- 狭めたいときは **GitHub App installation から repository を外す**

clone まで待たずに受付時に確認するのは、待つと数分後に**認証エラーとして**現れ、
「誰も権限を与えていないrepo」ではなく「壊れたdeployment」に見えるから。

## Alternatives

**`ALLOWED_REPOS` 許可リストを足す。** 最初はこちらを推奨案として提示した。
採らなかったのは、それが **credential が既に許している範囲の部分集合**にしかなり得ず、
二重管理になるから。権限を1箇所で持つならそれは GitHub App installation であって、
`wrangler.jsonc` の文字列ではない。片方だけ更新されて古くなるのは時間の問題だった。

**`false` のままにして、必要な人だけ開ける。** フィードバックの1と3は残る。
`false` は「第三者のリクエストを自分のsubscriptionで処理しない」ための歯止めとして
書かれていたが、その歯止めは実際には `REMOTE_CLAUDE_TOKEN` と Cloudflare Access であって、
repoの数ではない。**間違った場所に置かれた歯止めだった。**

**受付を通し、cloneの失敗に任せる。** 上記のとおり、症状が原因を指さない。

## Consequences

- ジョブ受付時に GitHub API 呼び出しが1回増える。**custom repo を渡したときだけ**で、
  既定のrepoでは増えない
- 結果をcacheしない。これは権限であって、5分前に剥がされた権限は権限ではない
- 個人利用専用という posture は変わらない。README のとおり、第三者のリクエストを
  自分の subscription credential で処理する構成にはしない
- 到達できない repo を渡したとき、エラーは**どこを直すか**を書く
  （GitHub → Settings → Applications → Configure → Repository access）
- deployment の `ALLOW_CUSTOM_REPO` を `false` に戻すことはできる。そのときの拒否文は
  両方のrepo名を含むので、利用者側で言い換える必要はない
