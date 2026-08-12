# remote-claude — 開発基盤として成立させるためのタスク

> 構造に影響する判断は [docs/adr/](adr/) に記録する。

目的は機能追加ではなく、**この基盤の上で spindle を実際に開発できる状態にすること**。
判定は「spindle の実装タスクを日常的にここへ投げられるか」。

以下はすべて**実際にジョブを流して観測された事実**にもとづく。推測起点の項目はない。

---

## P0 — これが直るまで実用に入れない

> 訂正履歴: 当初 RC-2 を P0 に置いたが、根拠とした観測が誤りだったため P1 へ降格した。
> 詳細は当該項目に残す。**実用の分かれ目は RC-1 のみ。**

### ~~RC-1. 実行モデルの是正（パイプラインをコンテナ内へ）~~ → 対応済み（ADR 0004）

**観測**: 51.5秒のジョブは完走。それを超えると `sandbox_runs.status = running` / `ended_at = null`
のまま落ちる（`execute()` の `finally` に到達しない）。`limits.cpu_ms` を上限の5分にしても解消せず。

**原因**: 数分かかるパイプラインを Durable Object の `waitUntil` コンテキストで走らせている。
公式ドキュメントは `waitUntil` が DO の寿命を延ばすかについて明言していない。DO は長時間実行のために
設計されていない。

**やること**: パイプライン本体をコンテナ内のスクリプトへ移し、DO は「起動・ポーリング・ログ中継」だけを行う。
副次的に、チャンクごとの redaction と SQL 書き込みが DO から消えて CPU 負荷も落ちる。

**完了条件**: 5分以上かかるジョブが完走する。

### ~~RC-2. 孤児 Sandbox の回収~~ → P1 へ降格（実装済み）

**当初の主張は誤りだった。** `wrangler containers list` の LIVE INSTANCES 3 を
「孤児が同時実行枠を埋めている」と読んだが、これは稼働中コンテナ数ではなく
プロビジョニング容量と見るのが妥当。根拠:

- **その表示のままジョブが正常に completed している**（キューで待たされていない）
- 値が `max_instances` と完全一致し、失敗4件・成功1件・複数回のdeploy・
  40分以上のアイドルを通じて一度も変動しない

したがって「キューが詰まる」という緊急性は存在しなかった。

ただし**修正自体は正しい**ので残す。DO が落ちると runner の `finally` は
実行されず `destroy()` が呼ばれないのは事実で、`sleepAfter` による回収に
委ねるより明示的に壊すほうが良い。緊急性がないだけで、間違いではない。

実装済み: ライフサイクル所有権を JobManager へ移し、構築時に掃除、
60秒の alarm を保険とする。**効果は未検証**（そもそも観測手段が上記のとおり
当てにならないため、検証方法から考え直す必要がある）。

### ~~RC-3. 一過性エラーのリトライ~~ → 対応済み

**観測**: `Sandbox operation sandbox.exec was interrupted while the platform was updating the
sandbox runtime` で1件失敗。Cloudflare 側のイベントであり、こちらのバグではない。

**やったこと**: runner 起動前だけ再試行する（ADR 0006）。起動後はプロンプトの再実行になるため対象外。
判定は `was interrupted while` を含む言い回しで、**実際に観測した2つの文言**をテストに引用してある。
加えて「起動したが何も報告せず死んだ」も再試行する（RC-15）。

---

## P1 — これが無いと使い続けるのが辛い

### ~~RC-4. Workspace キャッシュの有効化~~ → RC-10 / ADR 0011 に統合

**観測**: `install` に毎回 15〜27秒。clone も毎回。実装済みだが既定 off。

**決着**: 速度のためのキャッシュではなく、**ジョブを継続するための持ち越し**として配線した
（RC-10 / ADR 0011）。`node_modules` は運ばないので install は毎回走る — 継続の目的は
作業ツリーと会話であって、時間短縮ではない。

### ~~RC-5. ログの取りこぼし解消~~ → 解決済み

**観測**: バッファリング導入後、DO が落ちるとバッファ内の行が失われ、
**失敗が実際より早い時点で起きたように見えた**。デバッグを誤らせた。

**解決済み。** ログ経路がコンテナ側へ移った結果、原因が変わった。バッファは
in-memory であり、2秒ごとの alarm の合間にオブジェクトが退避すると失われる。
ポーリング単位でバッチが完結するため、ポーリングを跨いで保持する意味はない。
`mirrorLogs` の中でフラッシュするようにして解消。バッチ化の利点（1ポーリング1挿入）は保たれる。

### ~~RC-6. push と PR 作成~~ → 対応済み

**観測**: 1日で4本のジョブの成果を**すべて手で** `git apply` → commit → PR した。ループが閉じていない。

**着手して分かったこと**: `push` は実装されていなかった。**`pushed: false` が runner に
ハードコードされていた**まま、`push: true` は受け付けられ `ALLOW_PUSH` で門番もしていた。
「設定できるが効かない」の型なのに、直前の棚卸しはこれを取りこぼしている
（env var と client の耐性は見て、**request option を見ていなかった**）。

**やったこと**:
- runner が実際に push する（コミットが生まれたときだけ、失敗してもジョブは失敗させない）
- **書けるかどうかを GitHub に聞く** — `assertRepositoryWritable`。ADR 0010 と同じ考え方で、
  20分かけてから `git push` で落ちるのではなく受付時に拒否する
- 到達性チェックと同じ1本の GitHub 呼び出しに畳んだ（`fetchRepository`）

**push の live 検証**: 通った（`git-push` 2.5s、ブランチが GitHub 上に出現）。
その1本前は**チェックのバグで誤って拒否**していた —
`GET /repos/{owner}/{repo}` の `permissions.push` は installation token には返らないフィールドで、
恒久的に「書けない」と答えていた。権限は token 発行時のレスポンスから取るように直した。

**PR 作成**: `pullRequest?: {title?, body?, draft?}` として実装。**push を含む**。
Worker 側でやる（control plane の仕事で、`api.github.com` の認証も Worker が持っている）。
省略時は executor が組む — タイトルはプロンプトの1行目、本文は diffstat と実際に走った
チェックの結果で、**agent の締めの発言は入れない**（レビュー対象が書いた要約なので）。
**PR を開けなくてもジョブは失敗させない**（ブランチは push 済みで、成果は失われていない）。

---

## P2 — 後で

### ~~RC-7. 対話的ステアリング~~ → 対応済み（ADR 0011）

**観測**: spindle の実装タスクを投げたら、agent が「domain だけ組むか、API 契約をくれれば
本物のクライアントを書くか」と**質問を返して止まった**。失敗ではなく正しい停止で、
足りないのは能力ではなく**答えを返す経路**だった。

**やったこと**: 「実行中に操縦する」のではなく「**終わったジョブを続ける**」形にした
（`POST /jobs/:id/continue`）。同じブランチ・同じ workspace・同じ会話を引き継ぐので、
diff は1本に積み上がり、PR も1本のまま育つ。

継続には作業ツリーと会話の両方が要る。Claude Code は会話を HOME 側に置くので
`CLAUDE_CONFIG_DIR` を `/workspace/.claude` に向け、**snapshot 1つで両方運べる**ようにした（RC-10）。

**継続にならないなら拒否する**: 終わっていないジョブ、workspace が無い、会話が無い（agent が
走る前に落ちたジョブ）。**黙って fresh start になるのが唯一、結果から検出できない壊れ方**だから。

**残り**: ACP セッション（editor から人が操縦する面）はジョブ経路と別のまま。そちらは
pipeline を持たないので、成果物を出す経路としては continue が答えになった。

### ~~RC-8. 複数リポジトリ~~ → 対応済み（ADR 0010）

利用者から「`repo` を渡すと拒否される。任意の Project を扱うプロダクトからは必須」と指摘があり、
既定を `ALLOW_CUSTOM_REPO=true` にした。許可の境界は設定ではなく
**GitHub App installation が到達できる範囲**で、受付時に GitHub に確認する。

**残っている未検証**: live deployment に対して、installation 内の別 repo で
実際にジョブを完走させること。ユニットテストは
`src/application/job-service.test.ts` が覆っている（許可・拒否・到達不可・同一repoの別表記）。

### ~~RC-14. install / lint / test コマンドを repo ごとに決める~~ → 対応済み

**観測**: 最初の dogfood ジョブ（remote-claude 自身を対象）が install step で落ちた。
走ったのは spindle 用の `npm --prefix packages/spindle-core ci ...`。
**`skipChecks` は lint/test/build にしか効かず、install は必ず走る**ため回避策が無く、
`ALLOW_CUSTOM_REPO` を開けた（ADR 0010）ことは「別 repo を受け付けるが必ず失敗する」
状態を作っていた。**設定の単位が deployment なのに対象の単位が job になっている**のが
食い違いの本体で、それはこの1本を投げるまで「不便」だと思われていた。

**やったこと**: `JobRequest.commands` で job ごとに上書きできるようにした。
指定しなかったキーは deployment の値を継ぎ、空文字は「skip」という指示として通る。
これで executor のパイプライン自身が対象 repo を検証できる（`result.steps` に残る）。

### ~~RC-10. Workspace cache を配線するか、消す~~ → 両方やった

**観測**: `WORKSPACE_CACHE` / `WORKSPACE_CACHE_TTL` / `BACKUP_BUCKET` は config に読み込まれ、
Sandbox provider は `snapshot()` / `restore()` を実装していて、README には有効化手順と
R2 cleanup の節がある。**しかしジョブの経路がそれを一度も呼んでいない。**
`on` にしても毎回 fresh clone になる。層分け（ADR 0008）で `application` から
provider への呼び出しを数えたときに出てきた。

**やったこと**: **フラグは消し、機構は配線した。**

`WORKSPACE_CACHE` / `WORKSPACE_CACHE_TTL` は削除。**バインディングが唯一のスイッチ**になった
（フラグとバインディングは食い違えるし、実際この2つは存在した期間ずっと食い違っていた）。
snapshot は settle 時・teardown の前に取り、TTL はジョブ記録の保持期間と同じ7日。

そして**用途が変わった**。速度のためのキャッシュではなく、**ジョブを続けるための持ち越し**
（ADR 0011）。`.gitignore` を尊重するので運ぶのは作業ツリーと会話で、`node_modules` は運ばない
— 継続側で入れ直せばよい。

**設定できるが効かないものは、それを必要とする機能が来て初めて正しい形が分かる。**
「速度のため」に配線していたら、会話を含める設計にはならなかった。

### ~~RC-15. startup で沈黙したまま死んだ runner は再試行できる~~ → 対応済み

**5回の起動のうち2回**これで落ちた（RC-11 を委譲したジョブを含む）。稀ではない。
`shouldRetrySilentStartup` として実装し、status.json も出力も無い場合だけ requeue する。
併せて launch marker を追加して「shell が走ったか」を切り分けられるようにした。

**追記 (2026-08-11): 原因に手を入れた。** 再試行と marker は検知であって修正ではなかった。

runner は `setsid nohup node … &` を `exec` の中で背景化していた。つまり
**その shell の session が exec より長生きすることに賭けていた。** Sandbox SDK には
`startProcess`（プラットフォームがプロセスを所有し、`processId` を指定でき、
status と logs を後から聞ける）があるので、そちらに置き換えた。

marker は不要になった — **「shell が走ったか」を推測する代わりに、プラットフォームに
「そのプロセスを知っているか」を聞ける。** 失敗メッセージも
「記録が無い（起動していない）」と「まだ居るが何も出していない」を区別する。

runner の stdout/stderr もファイルへのリダイレクトではなくプラットフォームが持つ。

**そして、置き換えた直後のジョブが別の欠陥を露出させた。** install を43秒かけて完走し、
agent ステップに入ったところで **「reported nothing」として requeue された** — runner は生きていた。

原因は心拍判定が **status.json が読めたかどうかだけを見ていた**こと。読めないと `heartbeatAt` が
無くなり `startedAt` に落ちるので、**起動から90秒過ぎた健全なジョブが死んだと判定される。**
そのときログは数秒前まで進んでいた。

**出力が届いていることは、status ファイルより強い生存証拠。** 直した:

1. 心拍は `heartbeatAt` / `lastProgressAt` / `startedAt` の**最新**から測る。
   弱い信号が強い信号を否認できないようにした
2. `shouldRetrySilentStartup` に **「ログを1行でも出したか」** を足した。
   出していれば起動前の窓ではない — 3つの信号のうちいちばん強いものが抜けていた

**これは検知の追加ではなく、健全なジョブを殺す偽陽性だった。** 沈黙死の再試行を入れたときに
条件を「status と出力」で組み、**mirror されたログという手元にある証拠を使わなかった**のが元。

**追記 (2026-08-12): まだ終わっていなかった。原因は runner ではなくコンテナだった。**

偽陽性を直した次の実行から、3回連続で **開始から約2分**、agent ステップの途中で死んだ。
毎回 runner のプロセス記録が消えていた。順に潰した。

| # | 観測 | 分かったこと |
|---|---|---|
| 1 | deploy 完了の12秒後に開始。`interrupted while the runtime connection was closing` | コンテナのロールアウトが実行中のインスタンスを drain する |
| 2 | エラーは一切出ず、status ファイルだけが消える | sandbox は id 参照なので、実体が無ければ**空の新インスタンスが黙って作られる** |
| 3 | 3件すべて約2分で死ぬ | `SANDBOX_SLEEP_AFTER: "2m"` |

**根本原因**: `sleepAfter` は**コンテナへのリクエストの無活動**を計るタイマーで、
中で走っている作業は数えない。旧方式はパイプラインを長寿命の `exec` で回していたため
副作用としてコンテナが掴まれていた。ADR 0004 でパイプラインをコンテナ内へ移し、
RC-15 で runner を `startProcess` に替えた時点で、**起こしておく主体が居なくなった**。

この値を短く保つ判断は「sandbox はジョブ毎で再利用しないから、この窓は
ジョブ終了〜teardown の間だけ」というコメントで正当化されていた。
再利用については正しく、**タイマーが何を計っているかについては黙っていた。**

直したもの:

1. `SANDBOX_SLEEP_AFTER` を `"2m"` → `"35m"`（ジョブ予算より長く）。
   `config.ts` のフォールバックも `"5m"` で短く、**これはガードが捕まえた**
2. `src/conventions.test.ts` に **sleep タイマー > ジョブ予算** の検査を置いた。
   コメントはこれに気付けない
3. コンテナが消えた場合は runner 起動後でも再試行する（ADR 0006 追記）。
   判定は文言ではなく **executor が書いた `runner.mjs` が消えているか** —
   runner には作れない状態であり、置き換えが残す唯一の痕跡
4. runner が自分の cgroup を読み、70% 超えを10%刻みで記録する。
   `os.totalmem()` はコンテナ内でホストのメモリを返すので使えない。
   OOM とコンテナ消滅は外から見て同じ沈黙になるため、**死ぬ前に痕跡を残す**しかない
5. 失敗メッセージが status ファイルの **「古いまま残った」（コンテナは生存）** と
   **「消えた」（コンテナごと消滅）** を言い分ける

**検証 (msotedsh-9c908528)**: `claude-code` が **153秒** 走り（従来は約120秒で必ず死んだ）、
lint・test まで完走。1回目のコンテナは差し替えられたが**失敗させず再投入**して2回目が完走した。
メモリの梯子はゼロ = `basic` で足りている。

**この一連で3度出た同じ型**: 永続的な事実を、瞬間の読み取りで判定していた。
心拍（RC-15 偽陽性）、「status を書いたか」、「起動したか（`logSeq` だけ）」。
3つとも、記録に残っている証拠を使わず、いま読めるものだけで決めていた。

<details><summary>当初の記述</summary>

**観測**: 最初の完走したカナリアの1本前が
`runner stopped responding during "startup" (no heartbeat for 91s). (runner produced no output)`
で落ちた。**同じジョブをそのまま投げ直したら完走した**ので、コンテナ側の一時的な失敗。

いま再試行するのは `launch()` が例外を投げた場合だけで、この経路は対象外。だが
**status.json も runner.out も空という状態は「runner が何も実行していない」ことを意味する**
（runner は最初に status.json を書く）。つまり ADR 0006 の「runner が起動する前だけ再試行できる」
という条件を満たしている。

**やること**: `unresponsive` かつ phase が startup かつ runner の出力が空、という条件で
`shouldRetryLaunch` と同じ扱いにする。**条件を緩めないこと** — 出力が1行でもあれば
何かが走った可能性がある。

</details>

### ~~RC-11. ACP セッションを層の内側に入れる~~ → 対応済み

**観測**: `AgentSession` は再編成の外に残っていた。`loadConfig` と `getSandboxProvider` を
直接呼び、テストが1つも無く、**repo は常に `REPO_URL`**（`ALLOW_CUSTOM_REPO` を尊重しなかった）。

**やったこと**（2本のジョブに分けて委譲、設計はローカルで決めた）:

1. 純粋な部分を domain へ — `claudeProcessEnvironment`（3箇所の複製を畳み、
   `/health/auth` が `ANTHROPIC_BASE_URL` を unset していなかった穴を閉じた）と
   `buildClaudeCommand`
2. `AgentSessionService` を application に切り出し、`SessionStore` / `UpdateSink` /
   `Background` の3ポートを追加。DO は SSE・SQLite・`waitUntil` を持つ adapter になった。
   repo はジョブと同じ規則（`resolveRepository` + 到達性確認）で解決し、
   `POST /acp/sessions` が任意で受ける

**テスト12件**。clone が1回だけであること、init イベントの session id が次ターンの
`--resume` に載ること、実行中の2回目の prompt が拒否されること、cancel の stop reason など。
ゼロだった箇所。

**残り**: RC-7（ジョブ経路との接続）。これはセッションの構造ではなく製品としての判断。

### 同じ型の欠陥を洗う（2026-08-11 実施）

委譲を回して出た3つの欠陥（RC-14 / 環境変数の3重複製 / SDK が一過性 500 で死ぬ）は、
それぞれ**一般形**を持っていた。個別に直して終わりにせず、同じ型でリポジトリ全体を洗った結果。

**型1: 設定できるが、効く範囲が思っているものと違う**

- `skipChecks` が install に効かない → RC-14（対応済み）
- `ALLOW_PUSH` が読まれるだけで参照されない → 対応済み
- workspace cache 系が一度も呼ばれない → RC-10（未決）。
  `BACKUP_BUCKET_NAME` と `CLOUDFLARE_ACCOUNT_ID` も `Env` にあるが誰も読まない。同じ決定に属する
  → **どちらも Sandbox SDK が読んでいた。** workspace の持ち越し（ADR 0011）に両方必要で、
  2つだと思って2つ入れたら足りなかった。**「誰も読まない」は「このリポジトリの中では読まない」だった** —
  grep の範囲が結論の範囲になっていた
- `SANDBOX_TRANSPORT` は誰も読んでいないように見えたが、**Sandbox SDK が読んでいた**（誤検知）
- `max_instances` (3) と `MAX_CONCURRENCY` (3) は一致している ✅

**型2: 同じ規則が複数箇所にあり、片方だけ穴が開く**

- claude プロセスの環境変数が3箇所 → `/health/auth` だけ `ANTHROPIC_BASE_URL` の穴（対応済み）
- **redactor の秘密リストが3箇所 → ACP セッションのものだけ R2 の鍵2つを欠いていた**（対応済み）。
  `Secrets` interface + `satisfies Record<keyof Secrets, true>` にしたので、
  **秘密を1つ足して masking を忘れるとコンパイルが通らない**
- `REPO_DIR` が application 層に2箇所 → `application/workspace.ts` に統合（対応済み）

**型3: クライアントが一過性の失敗で死ぬ**

- SDK の `waitForJob` → 対応済み
- **`cli/remote-claude.mjs` の follow も同じ欠陥だった**（しかも `remote-claude run` の既定経路）→ 対応済み
- `cli/acp-bridge.mjs` は**最初から正しく再接続していた** ✅。同じリポジトリの中に正解の先例があった

**次にこの洗い方をするときの起点**: 「この設定を変えたら、本当に挙動が変わるか」
「この規則は何箇所に書かれているか」「この待ち受けは、相手が1秒消えたら死ぬか」。

### 洗った結果を、走るものにする（2026-08-11）

**型を見つけてインスタンスを直すだけでは、型が残る。** 手でやった監査のうち2つを
`src/conventions.test.ts` に移した — コードについてのテストで、`sdk-contract.ts` と同じ役割。

1. **投げられる Error は必ず種類を宣言している。** `Refusal`(400) / `NotFound`(404) /
   「500 が正しい」と理由付きで列挙されたもの、のいずれか。
   plain な `Error` を足すと落ち、**何を選ぶべきかを失敗メッセージが説明する**
2. **`Env` に宣言された設定は誰かが読んでいる。** src の中で参照されているか、
   `READ_BY_THE_SANDBOX_SDK` に理由付きで載っているかのどちらか。
   「誰も読まない」を grep の範囲で判断した失敗を、そのまま検査に埋めた

**この2つを入れた時点で、テストが触れていなかった5件が出た** — ACP のターン重複、
`SANDBOX_PROVIDER` 不明、GitHub App 未設定、秘密鍵が base64 でない、PKCS#8 でない。
**どれも「セットアップで最初に踏む所」が 500 で返っていた。**

### ~~RC-12. CLI と dashboard を SDK に載せ替える~~ → 対応済み

**観測**: `sdk/` を出した目的は「利用者がHTTPを手書きしない」ことなのに、
**このリポジトリ自身の CLI と dashboard が独自の fetch を持っていた。**
さらに CLI が一過性エラーの再試行を持ったことで、**同じ規則が2箇所**になった（型2）。

**publish 待ちではなかった。** blocker は「CLI は依存ゼロだから import できない」だったが、
依存ゼロは文書化された約束ではなく自己制約で、SDK のソースは `.js` 拡張子付きで
import しているため `sdk/dist` は**バンドラ無しでそのまま読める**。
`file:./sdk` を root の依存に置き、`npm install` 後に必ず揃うよう root の `prepare` で
ビルドする形にした（RC-9 の publish には依存しない）。

- 手書きの `api()` / `request()` / `TRANSIENT_RETRIES` / `TERMINAL` を削除
- `follow()` は `waitForJob` になった。カーソルを進める条件、終端後の tail 回収、
  deploy 中の 500 耐性は**すべて SDK 側の1箇所**になる
- `logs`（非 follow）は `format=text` をやめて follow と同じページング経路にした
- dashboard は build を持たないので、終端ステータスの集合だけを**配信時に注入**する。
  384行の読み取り専用ページのために node_modules を配るのは重複より悪い
- ビルドが無いときは、解決エラーではなく**打つべきコマンド**を出す

**検証**: 実 Worker に対して health / list / status / logs / logs -f / diff / sandboxes、
および 404 と 401 の経路を通した。

### ~~RC-13. interface 層のテスト~~ → 対応済み

**観測**: `domain` と `application` は146件で覆われているが、`interface/http` は0件。
`authorize()` は fail-closed（token未設定なら503）が要で、そこを固定したい。
ただし `crypto.subtle.timingSafeEqual` は workerd 固有で、いまの vitest (node) では走らない。
**やったこと**: pool-workers は足さなかった。`crypto.subtle.timingSafeEqual` を
**「あれば使う、無ければ手で XOR を積む」**形にした（`AbortSignal.any` に同じ前例がある）。
これで node の vitest でも走る。

書いてみて**3つ見つかった**:

1. **`router.ts` が infrastructure を直接 import していた**（auth probe）。ADR 0008 の
   「矢印は内向きだけ」に反していて、そのせいで container SDK が引きずられ、
   **このファイルはテストできなかった**。probe は entry から渡す形にした
2. **`Refusal` 型への切り替えで、呼び出し側の誤り3つが 400 から 500 に落ちていた**
   （`content-type must be...` / `invalid JSON body` / `text is required`）。
   正規表現をやめたときに拾い漏れていた。**テストが捕まえた**
3. 「token 未設定なら 503」という**いちばん重要な性質を誰も確かめていなかった**
4. 移行漏れを網羅的に洗ったところ（旧正規表現に一致する `throw new Error` の全数調査）漏れは0件だったが、
   **逆向きで1件見つかった** — 存在しないジョブの継続が 400、同じジョブの取得が 404 で、
   呼び出し側が「そんなジョブは無い」と「リクエストが悪い」を区別できなかった。`NotFound` を分けた

テスト36件（auth / errors / router）。`jobs` と `tasks` の両方で返すこと、`id` と `jobId` の両方、
diff が無いときは 404（空の patch ではない）といった**利用者が依存している形**も固定した。

### RC-9. SDK の publish

`sdk/` は package として成立していて CI が build まで通すが、**まだ npm に publish していない**。
それまで利用者は git 経由で参照するか vendor する必要がある（ADR 0009）。

---

## dogfood の方針

### いま委譲できるもの

- 自己完結した実装（インターフェースが決まっている、検証手段がある）
- テスト追加
- 機械的なリファクタ
- ドキュメント更新

### 委譲できないもの（構造上）

- **deploy と live 検証** — Sandbox に Cloudflare credential を渡さない設計なので原理的に不可
- **設計判断** — 一発勝負では途中で方向を変えられない
- **remote-claude 自身の RC-1** — 実行モデルを直す作業を、壊れている実行モデルの上では走らせにくい

### したがって

**RC-1 はローカルで直す。** それ以降は spindle 側の実装タスクを委譲していく。

ジョブモデルが一発勝負である以上、spindle の作業は
「自己完結・検証可能な単位」に分解する必要がある。これは制約であると同時に、
分解を強制されること自体が悪くない副作用でもある。
