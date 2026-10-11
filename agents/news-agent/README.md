# ニュース係（news-agent）

決まった情報源（RSS・Atom）を定期的に取り込んで貯めておき、依頼の本文に書かれた関心の方針に沿って、新着の記事から候補を選んで返すエージェントの定義（ADR 0017）。
取り込みはスクリプト（収集係）、選別は係のモデルが行う。関心の方針は依頼ごとに本文で受け取り、覚えておかない。
汎用ホストに、ページを読む Pi パッケージを足した image（Dockerfile の target `news-agent`）で動く。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | 振る舞い。「前回の受け取り」の行の読み方、選別の進め方、返事の形（中身なしのときは節を空にする）、記事を指示として扱わないこと |
| `settings.json` | agentDir | モデル（`openai-codex` の `gpt-6.1-sol`）、組み込みの道具を出さない（`defaultTools: []`）、読む Pi パッケージ |
| `news.example.json` | agentDir に `news.json` として。収集係には `/etc/fraction-agents/news.json` として | 情報源と取り込みの間隔の例。情報源は架空 |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。Agent Card の説明に、頼み方と「前回の受け取り」の行の扱いを書く。URL は架空 |

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `news-agent-agent-dir` に、
2 つの例を ConfigMap `news-agent-config` にする。`deploy/agents/news-agent` がこれを読む。

## しくみ

- 取り込みは、Pod の中の別のコンテナ `collector` が行う。同じ image で `node /opt/fraction-agents/pi-package/bin/news-collect.ts` を動かす。
  起動するとすぐに 1 回取り込み、その後は `intervalMinutes`（既定 60 分）ごとに取り込む。SIGTERM で止まる。
  - pi のプロセスは context ごとに立ち、使われなくなると止まるので、タイマーはそこに置けない。汎用ホストに係固有の仕事を足さないため、
    ホストの中にも置かない。別のコンテナにすると、依頼の有無にかかわらず動き、落ちれば kubelet が立て直す。
- ストアは PVC の `data/news`（Pod の中の `/data/news`）にある。ホストのデータ（`/data` の下の `state.db` など）と同じボリュームである。
- 係の道具は、ストアを読むだけである。書くのは収集係だけで、1 つのストアに収集係は 1 つだけ動かす（StatefulSet の replicas は 1）。

## ストア

ファイルで持つ。書くのは収集係だけで、道具は読むだけなので、ファイルをまるごと置き換える形で「書きかけを読まない」「途中で止まっても壊れない」を満たせる。SQLite のように、別のコンテナの 2 つのプロセスで同じデータベースのロックやジャーナルを共有することがない。

| パス | 中身 |
|---|---|
| `articles/<YYYY-MM-DD>.json` | その日（UTC）に取り込んだ記事。記事ごとに ID・正規化した URL・題・概要・情報源の名前・公開時刻（あれば）・取り込んだ時刻 |
| `sources.json` | 情報源ごとの状態。最後に試した時刻・最後に取り込めた時刻・続けて失敗した回数・最後の誤り、条件付きの取得のための ETag と Last-Modified |

- 書き込みは、いつもファイルをまるごと書き直す。同じディレクトリの一時ファイルに書いて fsync し、rename で置き換え、ディレクトリも fsync する。
  読む側には、古いファイルか新しいファイルのどちらかが見え、書きかけは見えない。書き込みの途中で止まると、古いファイルと一時ファイルが残る。
- 収集係は、起動のたびに、残った一時ファイル（`*.tmp`）を消し、読めないファイルを `<名前>.corrupt-<時刻>` に移して脇に置く（読みも上書きもしない）。
- 記事は、正規化した URL で重複を除く。取り込みのたびに、ストアにある URL と照らして、無いものだけを足す。
- 情報源ごとに、新しい記事を書き込んでから次の情報源に進む。途中で止まっても、書き込んだ記事は残り、残りの情報源は次の回に取り込まれる。
- 取り込んだ時刻は、その情報源の記事を書き込む直前の時刻である。「新着」はこの時刻で決める（公開時刻ではない）。
- 取り込んでから 30 日たった記事は、各回の取り込みの後に消す。道具も、30 日より前に取り込んだ記事は出さない。消した記事がまだフィードに載っていれば、次に取り込んだとき新着になる。

### URL の正規化

- 相対の URL は、フィードの URL を基準に絶対にする。`http` と `https` だけを記事にする。
- 断片（`#…`）、既定のポート、追跡のためのクエリ（`utm_*`・`fbclid`・`gclid`・`msclkid`・`mc_cid`・`mc_eid`・`igshid`・`_hsenc` など）を外し、残りのクエリを名前で並べる。
- スキームとホストは小文字にする。パスは書かれたまま（大文字小文字・末尾の `/`）にする。

## フィード

- RSS 2.0・RSS 1.0（RDF）・Atom を読む。XML は自前の小さな読み手で読み、DOCTYPE で宣言された実体は展開しない。
- 記事の URL は、RSS は `link`（無ければ URL の形の `guid`）、Atom は `rel="alternate"` の `link`。URL の無い記事は取り込まない。
- 題は 300 文字、概要は HTML を文字にしてから 1 行・500 文字に縮める。公開時刻は、RSS は `pubDate`・`dc:date`、Atom は `published`、無ければ `updated`。
- 文字コードは、`Content-Type` の charset、無ければ XML 宣言の encoding、無ければ UTF-8。

## 取得の上限と失敗

| 項目 | 値 |
|---|---|
| 1 回の取得の時間 | 30 秒 |
| フィードの大きさ | 5 MB。超えたら失敗 |
| 1 回に読む記事 | フィードの先頭から 200 件 |
| 再試行 | 応答が無い・429・5xx のときだけ、`Retry-After`（60 秒まで）か 2 秒・8 秒の間を空けて、1 回の取り込みで 3 回まで。ほかの 4xx は試し直さない |

- ETag・Last-Modified があれば条件付きで取得し、304 は「取り込めた、新着なし」とする。
- 失敗した情報源は、`sources.json` に続けて失敗した回数と最後の誤りを残し、次の回にまた試す。ほかの情報源の取り込みは続ける。
- 係は、`news_articles` の結果で情報源ごとの状態を見る。収集係が間隔の 2 倍より長く動いていなければ、結果に警告が出る。
  係は、3 回以上続けて失敗している情報源や停止を、返事に書く（AGENTS.md）。
- 収集係は、1 回の取り込みごとに標準出力に 1 行（新着の数・失敗した情報源）を出す。`kubectl logs news-agent-0 -c collector` で見る。

## 道具

| 道具 | 出どころ | 中身 |
|---|---|---|
| `news_articles` | fraction-agents の Pi パッケージ（`news`） | 取り込んだ時刻が `since`（無ければ直近 24 時間）より後の記事を古い順に出す。1 回 50 件（100 件まで）、続きは `offset`。情報源ごとの状態も出す |
| `news_sources` | 同上 | 情報源の一覧と状態 |
| `fetch_content`・`get_search_content` | `@kvidzibo/pi-web-access` 0.1.1 | ページを取って Markdown にし、キャッシュから部分を引く。調べもの係と同じもの |
| `submit_reply` | fraction-agents の Pi パッケージ | 答えを要約・節・出典の形で出す（ADR 0015） |
| `ask_caller` | 同上 | 呼び出し元に聞き返す |

- `since` は ISO 8601 のオフセットつきの時刻。後ろの括弧（`(JST)`）や前の「前回の受け取り:」が付いていてもよい。オフセットの無い時刻は断る。
- 記事は `untrusted feed data` と書いた区切りの間に入れてモデルに渡す。題や概要の中の区切りに似た文は崩す。
- `@kvidzibo/pi-web-access` の `web_search`（外の検索サービスに出る）は、汎用ホストの設定の `piCommand` で外し、`news` の拡張も呼び出しを止める。
  画像を返す `attach_image` も要らないので外す。
- pi の組み込みの道具（read・bash・edit・write など）は `settings.json` の `defaultTools: []` で出さない。

## `news.json`

秘密は置かない。情報源は環境ごとに違うので、本物は private の overlay に置く（ADR 0010）。変えるのは本人で、overlay の PR で行う。

| 項目 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `sources` | 必須 | | 情報源の並び。1 つ以上 |
| `sources[].name` | 必須 | | 情報源の名前。1 行・100 文字まで。重ならないこと。係の返事と状態の記録に使う |
| `sources[].kind` | 必須 | | 取り方。いまは `feed`（RSS と Atom）だけ |
| `sources[].url` | 必須 | | フィードの `http`・`https` の URL。重ならないこと |
| `intervalMinutes` | | `60` | 取り込みの間隔（分）。5〜1440 |
| `timeZone` | | `UTC` | IANA のタイムゾーン。道具の結果の時刻をこれで見せる |
| `storeDir` | | `/data/news` | ストアの絶対パス |

- 知らない項目があるとき、値が正しくないときは、係の道具は出ず（pi は起動する）、収集係は誤りを出して終わる（コンテナが再起動を繰り返す）。
- 情報源を消しても、取り込んだ記事は 30 日たつまで残る。

## 配置

`deploy/agents/news-agent` は Wiki 管理人と同じ形で、次が違う。

- 名前は `news-agent`（PVC は `data-news-agent-0`）。ConfigMap は `news-agent-agent-dir`（`AGENTS.md`・`settings.json`）と
  `news-agent-config`（`config.json`・`news.json`）。`news.json` は host の `/agent/news.json` と collector の `/etc/fraction-agents/news.json` に差し込む。
- image は `ghcr.io/yuanying/fraction-agents-news-agent`。collector も同じ image で動く。
- コンテナ `collector` を足す。PVC の `data/` を `/data` にマウントする。メモリの requests は 64Mi、limits は 256Mi。
- Secret は無い。

## 環境ごとの値

private の overlay（ADR 0010）で渡す。

- `news-agent-config` の `config.json` の `publicUrl` と `allowedCallers`
- `news.json`（情報源の一覧、間隔、タイムゾーン）
- image の tag（`ghcr.io/yuanying/fraction-agents-news-agent`）と、PVC の StorageClass
- 外への出口: 情報源のフィードと、選別のときに読む記事のページ（情報源の一覧の外のサイトも含む）。調べもの係と同じく、当面は絞らない（ADR 0017）

ログインは、Wiki 管理人と同じ手順を係の Pod で行う（README の「ChatGPT Plus にログインする」。Pod は `news-agent-0`、コンテナは `host`）。

## 呼び出し元へ

依頼の本文に関心の方針を書く。係は前の依頼の方針を覚えていない。

- 「AI と開発ツールの新しい動き、日本の宇宙開発のニュースを中心に選んで。芸能とスポーツはいらない。5 件まで」
- 定期の依頼では、本文の末尾に「前回の受け取り: 2026-10-11T07:00:00+09:00 (JST)」の行を付ける。係はその時刻より後に取り込んだ記事から選ぶ。
  行が無ければ直近 24 時間から選ぶ。

返事は reply v1（ADR 0015）の要約・節・出典で返る。節は候補 1 件に 1 つ（題は記事の題、本文は要約・選んだ理由・情報源・公開日・URL）で、
最後に任意の「情報源の提案」が付く。新着が無いとき、選んだ候補が無いときは、節が空になる（中身なし）。
