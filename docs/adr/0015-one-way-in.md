# 0015. 入口は1つにする — SDK と CLI

- Status: Accepted
- Date: 2026-08-14

## Context

executor には利用者側の面が4つあった。

| 面 | 実体 |
|---|---|
| SDK | `sdk/`（npm 公開） |
| CLI | `cli/remote-claude.mjs` |
| ダッシュボード | `cli/dashboard.html` + `remote-claude ui` |
| ACP セッション | `/acp/sessions/*` + `AgentSession` DO + `cli/acp-bridge.mjs` |

後の2つは、作った時点では理由があった。ダッシュボードは「トークンを持つ機械の上だけで開く
画面」で、ACP は「エディタからサンドボックスの Claude Code を local のように駆動する」ため。

**その理由が両方とも消えた。** 画面は spindle 側に Terminal タブができた
（ADR 0012 のストリームがその feed になる）。そして ACP セッションは、
**ジョブが持っている保証を1つも持っていない**:

| | ジョブ | ACP セッション |
|---|---|---|
| workspace の保存と復元 | あり | なし |
| diff / patch | R2 に保存 | 経路なし |
| push / PR | あり | なし |
| 同時実行数・sandbox 台帳 | あり | キューに繋がっていない |
| 会話の継続 | `continueJob` + `--resume` | セッション内のみ |

多ターンの対話は ACP を作った理由の中心だったが、それは ADR 0011 の追加ターンで
ジョブ経路に入った。**残っていたのは「別の道」だけで、その道は保証が薄い。**

## Decision

**入口は SDK と CLI の2つだけにする。** ダッシュボードと ACP のプロトコル面を削除した。

- `cli/dashboard.html`、`remote-claude ui`
- `/acp/sessions/*` のルート、`AgentSession` DO（`deleted_classes` で削除）、
  `agent-session-service.ts`、`cli/acp-bridge.mjs`
- ACP のためだけにあった JSON-RPC の配線と `ACP_PROTOCOL_VERSION`

**`session/update` の語彙と翻訳器は残す。** `domain/agent/acp.ts` の
`translateEvent` / `describeUpdate` は、Claude Code の `stream-json` を
ジョブのログが読める行にするために使われている（`· Read acp.ts` はこれが作る）。
語彙として ACP の形を借りているのは、同じことを言う別の形を発明しても
何も得られないから。

## Alternatives

**ACP を web の対話路にする。** 検討して採らなかった。技術的には繋がる
（`?since=` で再開する SSE も既にあった）が、spindle 自身の要件 R4 が
**入力路を作らないでほしい**と明示していた — web からサンドボックスに届く
プロンプトは、その機械が見えるもの全部に対する shell である、という理由で。
加えて成果物と資源管理を作り直すことになる。

**Orchestrator をサンドボックスで動かすために残す。** 動機としては筋が通るが、
Orchestrator はコードを走らせない。**決めて待つもの**の置き場所は、
台帳と alarm を持つ control plane 側（Worker / DO）で、
サンドボックスに入れるには executor のトークンをコンテナに置く必要がある —
ADR 0002 と 0013 が引いた線の反対側である。

## Consequences

- エディタ（Zed 等）からの接続はできなくなる。**戻すなら bridge だけでは足りず**、
  上の表の空欄を埋める必要がある
- 生の対話が必要になったときに作るべき形は、第二のプロトコルではなく
  **走っているジョブへの追加入力**。台帳・成果物・継続の保証をそのまま使える
- 面が減った分、`conventions.test.ts` の「文書が名乗るフラグはそのコマンドが持つ」
  ガードの対象も減る。守る面が少ないほど、守り漏れも少ない
