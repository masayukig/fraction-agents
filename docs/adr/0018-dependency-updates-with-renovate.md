# 0018. 依存の更新は Renovate に追わせ、公開から 7 日経った版だけを受け取る

- Date: 2026-10-12
- Status: Accepted

## Context

このリポジトリは、依存の版をすべて固定している。npm の依存は `package.json` に版をそのまま書き、lock で固める。
image の中の第三者の Pi パッケージとブラウザの CLI も、`images/` の下の `package.json` と lock で固める（ADR 0013、0017）。
Node は Dockerfile のベースの image と、テストのワークフローの setup-node の両方に同じ版で書いている。
pi は Dockerfile の中で、版を付けて npm でグローバルに入れている。

固定は、放っておくと古くなる。上げ続ける人がいなければ、いずれ脆弱性の直った版にも、Pi の新しい版が前提にする版にも届かない。
手で上げるなら「そろそろ上げる」と思い出す人が要る。

一方で、公開された直後の版は、取り下げられたり、数日のうちに直しの版が出たりする。乗っ取られた公開元から悪い版が出る場合も、
気づかれて消されるまでの数日がいちばん危ない。新しい版をすぐに受け取ることは、この期間をそのまま引き受けることになる。

本人は fleet-infra と gated で Renovate を使っている。gated の設定は `config:recommended` を土台にし、規則ごとに理由を書く形である。

## Decision

### 更新の担い手を Renovate にする

依存の更新は Renovate に任せる。設定はリポジトリ直下の `renovate.json` に置き、gated に揃えて `config:recommended` を土台にする。
時刻は `Asia/Tokyo`、Dependency Dashboard を使う。規則と custom manager には、なぜそうするのかを `description` に書く。

### 公開から 7 日経った版だけを受け取る

全体に `minimumReleaseAge` を 7 日で効かせる。7 日経っていない版は、branch も PR も作らない（`internalChecksFilter` を `strict` にする）。
`strict` は Renovate の既定だが、待ちが「PR の状態の検査」ではなく「branch と PR そのものを出さないこと」であると設定から読めるように書いておく。

`strict` では、7 日経った版の中でいちばん新しいものを提案する。待っている間に次の版が出ても、PR が出ないまま待ち続けるのではなく、
7 日経った手前の版が届く。7 日経った版が 1 つもなければ、Dependency Dashboard に保留として載る。

公開の時刻が取れない版は、7 日経ったかを判断できないので保留のままになる（Renovate の既定）。

### Node は Docker のタグではなく Node の版として読む

Node の版は、Dockerfile のベースの image（`node:<版>-bookworm-slim`、2 か所）と、テストのワークフローの setup-node に書いてある。
テストを通った Node と image の Node は同じでなければ意味がないので、この 3 か所を 1 つのグループ `node` にして、1 つの PR で上げる。

Dockerfile の image のタグを Docker の image として読むと、7 日の待ちが正しく働かない。
Docker のタグの時刻は、そのタグが最後に push された時刻であり、Node が出た時刻ではない。同じタグが Debian の層の焼き直しのたびに push し直される。
Docker Hub が時刻を返さないこともあり、そのときは保留のまま動かない。
同じグループの setup-node の側は Node の版の時刻で 7 日を数えるので、image の側だけが取り残され、グループにした意味がなくなる。

そこで Dockerfile の Node は custom manager で版の部分だけを読み、Node の版の一覧（setup-node と同じ datasource）で追う。
タグの `-bookworm-slim` の部分は書かれたまま残る。Dockerfile の標準の manager が同じ Node を二重に提案しないよう、そちらの Node は無効にする。
こうすると 3 か所とも同じ時刻で 7 日を数え、同じ日に同じ版が届く。

Node の major は、Renovate の Node の版の扱いに従い、LTS になった版だけが届く。

### `@types/node` の major は Node と一緒に手で上げる

`@types/node` は、コードが動く Node の型である。その major は Node の major に対応するが、Node が LTS になるより先に出る。
これを先に上げると、image の Node に無い API を型検査が通してしまう。`@types/node` の major は Renovate に出させず、`node` のグループの major を受け取るときに手で合わせる。
minor と patch は Renovate に任せる。

### pi は custom manager で追う

pi は Dockerfile の中で版を付けてグローバルに入れているので、標準の manager は版を読まない。
pi はすべてのエージェントが動く土台であり（ADR 0007）、Dockerfile に書いた版がそのまま image の版になる。custom manager で Dockerfile のその版を npm の版として追う。

### 自分の image のタグは動かさない

manifest に出てくる `ghcr.io/yuanying/fraction-agents` とその派生の image は、このリポジトリ自身のものである。
manifest は remote base で、使う版は環境の overlay が決める（ADR 0010）。タグを動かすのは overlay を持つリポジトリの Renovate の役目である。
いまの kustomization はタグを書いていないので Renovate は読み飛ばすが、将来タグが書かれても動かさないように、規則で無効にしておく。

### PR の数を抑える

GitHub Actions は 1 つのグループにまとめる。どれも同じ見方で確かめるもので、1 つずつ届けても PR の数が増えるだけである。
`config:recommended` の既定どおり、major は minor・patch と別の PR になる。setup-node の Node は Actions のグループではなく `node` のグループに入る。

### 追わないもの

- Dockerfile が apt で入れるパッケージ（bash、git、ripgrep、Chromium など）は版を書いていない。Debian の配布に任せ、image の再ビルドで新しくなる。
- `package.json` の `engines` の Node は下限の範囲なので、Renovate は書き換えない。上げる理由があるときに手で上げる。
- Pi パッケージの `typebox` の peer dependency は範囲を限っていない。版を持つのは pi の側である。

## Consequences

固定した依存が古びていくことに、人の記憶以外の歯止めがかかる。届いた PR はテストのワークフローと image のビルドが確かめる。

新しい版は、最短でも公開から 7 日遅れて届く。公開直後に取り下げられた版や悪い版は、その間に消えていれば届かない。
代わりに、急いで受け取りたい直し（脆弱性の修正など）も 7 日待つ。待てないときは手で上げる。

Node は image とテストで同じ版のまま上がる。その代わり、Dockerfile の Node のタグの付け方（`node:<版>-<変種>`）を変えるときは、custom manager の読み方も合わせて変える必要がある。
読めなくなっても Renovate は何も言わずに Dockerfile の Node を追わなくなるだけなので、Dependency Dashboard の一覧に Dockerfile の Node が載っているかで確かめる。
pi のインストールの書き方を変えるときも同じである。

Renovate の設定はこのリポジトリにあるが、Renovate 自体はここにない。構文は `renovate-config-validator` で確かめられ、
何が拾われるかは手元で Renovate を `--platform=local` で動かせば確かめられる。それでも、実際に何が届くかは PR が届くまで分からない。

## 関連 ADR

- [[0007-generic-host-runs-pi-per-context]] — pi がすべてのエージェントの土台であること。pi を custom manager で追う理由
- [[0010-manifest-base-and-private-overlay]] — image のタグを決めるのは overlay であること。自分の image を Renovate で動かさない理由
- [[0013-web-researcher]] — 調べもの係の image の第三者のパッケージを lock で固めていること
- [[0017-news-agent]] — ニュース係の image の第三者のパッケージを lock で固めていること
