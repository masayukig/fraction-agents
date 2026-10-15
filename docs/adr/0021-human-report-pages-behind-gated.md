# 0021. 人がレポートを見るページは A2A とは別の listener で出し、gated のアサーションで確かめる

- Date: 2026-10-15
- Status: Accepted

## Context

汎用ホストが保存したレポート（ADR 0020）を、本人がブラウザで見られるようにする。本人と決めたことは次のとおりである。

- 人は、クラスタの入口の gated（GitHub のログインで認可する Ingress controller）でログインして、直接見る。gated の改修もこの範囲に入れる。
- 見るのは、レポートのページと一覧（見るだけ。新しい順で、日時・題・依頼元）である。ブラウザから消す口は作らない。
- 退けた案: 推測できない URL を認証なしで出す。URL が漏れれば誰でも見られる。

gated と今のエージェントの口について、調べて分かったことは次のとおりである。

- エージェントは係ごとに 1 つのホスト名と Ingress で出ており、gated の NetworkRole は付けていない。gated は NetworkRole に参照されない Ingress を素通しにし、守りはエージェントの Bearer の認証（ADR 0003・0006）である。
- 同じ Ingress の中でもパスで NetworkRole を分けられる。ただし機械の口を足すたびに NetworkRole も直すことになり、この係だけ Ingress と gated の設定が強く結びつく。
- 守られた口に Bearer だけで来た要求は、gated の 401（`Basic realm="gated"`）で止まり、backend に届かない。機械と人が同じ口を使うと、ここでぶつかる。
- gated は、守っている限り許した主体の要求しか通さないが、それを backend に伝えない。だから gated を通らない 2 つの道を backend は断れない。
  1. クラスタの中の Pod から Service へ直接来る道。NetworkPolicy はまだ効いていない（ADR 0003）。
  2. gated の設定が fail-open になったとき。NetworkRole の `targetRef` を書き間違えると、守ったつもりの Ingress が素通しになる。
- ADR 0003・0006 は、NetworkPolicy が効くまで、穴は認証で塞ぎ、認証を通らない依頼を一切処理しないことを前提にしている。一覧のページはすべてのレポートを出すので、穴が開けばすべてが読める。

そこで gated に、ログインした主体を署名付きで backend に伝える仕組みを足した（gated ADR 0034「バックエンドに主体を署名付きで伝える」）。要点は次のとおりである。

- 主体が決まった要求に、gated が署名した短い主張（アサーション）を `Gated-Assertion` ヘッダで付ける。形は JWS の compact 形式で、署名は Ed25519（`alg` は `EdDSA`、`typ` は `gated-assertion+jwt`）。
- 中身は、発行元（`iss`、中央認証ホストの origin）・主体（`sub`、`github:<login>` など）・要求のホスト名（`aud`）・発行時刻・期限（60 秒）である。
- 公開鍵は、中央認証ホストの `/__gated/jwks.json` で JWKS として配る。
- gated は、クライアントが付けた `Gated-` で始まるヘッダを、すべての要求から消す。
- backend は、ADR 0034 の「バックエンドが確かめること」の 8 段で確かめる。

本人は、gated のこの改修を先に作り、それがそろってから人用のページを公開すると決めた。機械の口（A2A・`report get`・なつみ）は、これを待たずに作れる。

## Decision

### 口を分ける

- 人用のページは、A2A とは別の listener（別のポート）で出す。
  - 人用の listener には、A2A・Agent Card・機械のレポートの口（ADR 0020）・画像の成果物を置かない。
  - A2A の listener には、人用のページを置かない。
- 環境では、人用のポートを別のホスト名と別の Ingress で出し、その Ingress を gated の NetworkRole でホスト全体ごと本人だけに開く。A2A のホスト名は、ほかの係と同じく NetworkRole なしのままにする。
  - 人用のホストには機械が来ず、gated の Cookie は人用のホストにだけ付く。Bearer と gated のログインがぶつからない。
  - 人用の Ingress を消しても、そのホストは素通しにならず 404 になる。
  - ホスト名・Ingress・NetworkRole の具体は、環境の overlay に書く（ADR 0010）。
- 退けた案: 同じホスト名の中でパスで分け、NetworkRole を 2 つ当てる。機械の口を足すたびに NetworkRole を直すことになり、A2A の要求も gated の判定の中を通る。

### 設定

- `reports` の中に `web` を足す。無ければ人用の listener を立てない。

| 項目 | 意味 |
|---|---|
| `port` | 人用の listener のポート |
| `publicUrl` | 人から見た人用のページの URL。返事の「レポート」の節の URL（ADR 0020）と、アサーションの `aud` と比べるホスト名に使う |
| `gated.issuer` | 受け付けるアサーションの発行元（gated の中央認証ホストの origin） |
| `gated.jwksUrl` | 公開鍵の JWKS の URL |
| `allowedSubjects` | 見てよい主体の並び（例 `github:<本人の login>`） |

- どれも環境に固有の値で、既定を持たない。`web` を書くなら全部を必須にする。

### アサーションを確かめる

人用の listener は、すべての要求で、ページを返す前に gated ADR 0034 の 8 段で `Gated-Assertion` を確かめる。

1. `Gated-Assertion` ヘッダがあること。
2. JWS の compact 形式として読め、`alg` が `EdDSA`、`typ` が `gated-assertion+jwt` であること。受け付ける `alg` は自分の側で固定する。
3. `kid` に当たる公開鍵が、設定の `gated.jwksUrl` の JWKS にあること。JWKS の URL はアサーションから読まない。
4. その公開鍵で署名が検証できること。
5. `iss` が設定の `gated.issuer` と一致すること。
6. `aud` が設定の `publicUrl` のホスト名（小文字、ポートなし）と一致すること。要求の `Host` ヘッダとは比べない。
7. `exp` が過ぎておらず、`iat` が未来すぎないこと。時計のずれは 30 秒まで許す。
8. `sub` が設定の `allowedSubjects` にあること。

- 1〜7 のどれかを満たさなければ 401、8 を満たさなければ 403 を返す。どちらも本文に理由を書かず、理由はホストのログに残す。ページの中身は返さない。
- JWKS はキャッシュする。応答のキャッシュの期限に従い、長くても 5 分で取り直す。知らない `kid` が来たら、前に取ってから 1 分以上空いていれば一度だけ取り直す。
  JWKS が取れないときは、キャッシュにある鍵で確かめ続ける。キャッシュに無ければ、その要求は 3 で落ちる。
- 確かめるのに外の依存を足すかどうか（JWS の検証のライブラリか、Node の標準の暗号で書くか）は実装で決める。
- 退けた案: 当面は確かめずに gated に任せ、穴が残ることを書いておく。ADR 0003・0006 の前提の例外になり、fail-open は静かに起きて、気づくまで一覧がインターネットに出る。

これで、gated を通らずに届いた要求（クラスタの中から直接、fail-open の Ingress を通って）にはアサーションが無いので 401 になる。gated の版がアサーションを付ける前のものでも、人用のページは何も返さないだけで、穴にはならない。

### ページ

| 口 | 中身 |
|---|---|
| `GET /` | 一覧。すべての呼び出し元のレポートを新しい順に、作った時刻・題・依頼した呼び出し元・途中までか |
| `GET /reports/<ID>` | レポートのページ。ADR 0020 の型で作った HTML に、Mermaid の図を描く script を足したもの |
| `GET /reports/<ID>.md` | レポートの本文の Markdown |
| `GET /assets/...` | ページが使う CSS と script（Mermaid と、それを起動する小さな script）。image に同梱し、外の CDN から読まない |

- 見るだけで、`GET` と `HEAD` 以外は 405 を返す。消す口は置かない（ADR 0020 の「消し方」）。
- 人は本人なので、どの呼び出し元のレポートも見られる。持ち主で閉じるのは機械の口だけである（ADR 0020）。
- 依頼した呼び出し元は、ServiceAccount の名前の最後の部分（例 `claude`）で出す。時刻はホストのタイムゾーン（`TZ`）で出す。
- 一覧の題はモデルが書いた文なので、HTML としてではなく文として出す。
- 一覧に件数の上限やページ送りを付けるかは実装で決める。

### 配るときの守り

人用の listener のすべての応答に、次のヘッダを付ける。

- Content Security Policy: 既定は何も許さず、script・CSS・画像・フォントは自分の origin のものだけを許す。Mermaid が図の中に style を書くので、style だけは inline を許す。
  外への接続（`connect-src`）とフォームの送信先は許さない。frame に入れられることを許さない（`frame-ancestors 'none'`）。`base` を許さない。
  - inline の script は許さない。Mermaid の起動も `/assets/` のファイルで行う。
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`。レポートの中の外へのリンクを開いたときに、レポートの URL を外に伝えない。
- `Cache-Control: private, no-store`
- `Cross-Origin-Opener-Policy: same-origin`
- Mermaid は、図の文から HTML を作らない最も厳しい設定で動かす。

## Consequences

- 本人は、gated のログインだけでレポートと一覧をブラウザで見られる。Claude などは、今までどおり Bearer で A2A のホスト名から取る。
- gated の守りとホストの確かめが別々に効く。どちらか一方の設定を誤っても、もう一方が残る。
- 人用のページは、gated の版がアサーションを付けるものに上がり、環境の設定（ホスト名・Ingress・NetworkRole・ホストの `reports.web`）がそろうまで使えない。その前に人用のポートを出しても、401 を返すだけである。
- ホストが、gated の中央認証ホストの JWKS に依存する。取れなくても、キャッシュの鍵で確かめ続ける。gated が鍵を替えるときは、gated ADR 0034 の手順（先に公開する）に従えば、ページは落ちない。
- 環境には、ホスト名・証明書・Ingress・ポートが 1 つずつ増える。
- NetworkRole と `allowedSubjects` に、同じ主体を 2 か所に書く。二重に書くのは意図したものである。片方だけを直すと、本人が見られなくなる方に倒れる。
- Mermaid の script を同梱するので、image が少し大きくなる。図は外から来た文から描くので、Mermaid の脆弱性はこのページに及ぶ。script は自分の origin のものしか動かず、ページから外へはつながらない。
- アサーションは、同じホストの下の別の backend に期限内なら使い回せる（gated ADR 0034）。人用のホストにはこの listener だけを置くので、問題にならない。
