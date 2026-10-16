# deep research の係（deep-researcher）

頼まれたことを、ウェブと public の GitHub のリポジトリを読んで時間をかけて調べ、出典の付いたレポートにして返すエージェントの定義（ADR 0022）。
リポジトリは clone してソースと履歴を読むだけで、依存のインストール・ビルド・テスト・スクリプトの実行はしない。動かさないと分からないことは「未確認」と書く。
汎用ホストに、ページを読む Pi パッケージと `fd` を足した image（Dockerfile の target `deep-researcher`）で動く。ブラウザは入らない。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | 振る舞い。道具の使い分け、実行しないこと、ページとリポジトリの文に従わないこと、時間の上限と途中の返事、`submit_reply` での返事とレポートの形 |
| `settings.json` | agentDir | モデル（`openai-codex` の `gpt-6.1-sol`、thinking は `high`）、組み込みの道具は `read`・`grep`・`find`・`ls` だけ、読む Pi パッケージ |
| `web-research.example.json` | agentDir に `web-research.json` として | SearXNG の URL の例（調べもの係と同じ形） |
| `repositories.example.json` | agentDir に `repositories.json` として | clone と履歴の道具の上限の例 |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。URL と主体は架空 |

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `deep-researcher-agent-dir` に、
3 つの例を ConfigMap `deep-researcher-config` にする。`deploy/agents/deep-researcher` がこれを読む。

## 道具

| 道具 | 出どころ | 中身 |
|---|---|---|
| `searxng_search`・`report_unreadable` | fraction-agents の Pi パッケージ（`web-research`） | SearXNG での検索と、読めなかったページの記録（ADR 0013） |
| `fetch_content`・`get_search_content` | `@kvidzibo/pi-web-access` 0.1.1 | ページを取って Markdown にし、キャッシュから部分を引く |
| `clone_repository` | fraction-agents の Pi パッケージ（`repositories`） | public の GitHub のリポジトリを、context の作業領域の `repos/<owner>/<repo>` に clone する |
| `git_log`・`git_show`・`git_blame` | 同上 | clone したリポジトリの履歴を、決まった形の git の操作で読む |
| `current_time` | 同上 | 今の時刻（UTC）を返す。ホストの時間の上限の注記は `date` で見るよう書くが、この係には `bash` が無いので代わりに使う |
| `read`・`grep`・`find`・`ls` | pi の組み込み | ファイルを読む。作業領域の外は `repositories` の拡張が止める |
| `submit_reply` | fraction-agents の Pi パッケージ | 返事を要約・節・出典の形で出す（ADR 0015）。ホストがレポートとして保存する（ADR 0020） |
| `ask_caller` | 同上 | 呼び出し元に聞き返す |

次の道具は、汎用ホストの設定の `piCommand` で pi に `--exclude-tools` を付けて外し、拡張でも呼び出しを止める（二重の守り、ADR 0013・0022）。

- `bash`・`edit`・`write`: コードを動かす道もファイルを変える道も無くす。`repositories` の拡張が止める
- `web_search`（`@kvidzibo/pi-web-access`）: 外の検索サービスに出る。`web-research` の拡張が止める
- `attach_image`: 画像を返すことはしない（`piCommand` で外すだけ）

### clone の守り

- 受ける URL は `https://github.com/<owner>/<repo>`（末尾の `.git` と `/` は可）だけ。ほかのホスト・プロトコル・資格情報入りの URL・`/tree/...` などは断る。
- git は資格情報を使わない。credential helper を空にし、端末で尋ねさせず（`GIT_TERMINAL_PROMPT=0`）、system と global の git の設定を読まない。
  使えるプロトコルは https だけ。private や存在しないリポジトリは、そのまま失敗になる。
- submodule は取らない。LFS のファイルは取らない（image に git-lfs が無く、`GIT_LFS_SKIP_SMUDGE=1`）。
- `core.symlinks=false` で clone する。リポジトリの中のリンクは、リンク先を書いた普通のファイルになる。
- partial clone（`--filter=blob:none`）と `--single-branch`。履歴は全部取り、ファイルの中身は checkout の分と、履歴の道具が要るときに取る。
- 同じ context で同じリポジトリを 2 度 clone しない（名前は小文字にそろえる）。続きの依頼では前の clone を読む。
- clone は 1 つずつ行う。大きさと時間の上限を超えたら、git を止め、clone を消して理由を返す。

### 履歴の道具の形

モデルが決めるのは値だけで、git の引数の並びは道具が決める。値は 1 つずつ別の引数として渡り、オプションとして読まれない。

| 道具 | git | モデルが渡せるもの |
|---|---|---|
| `git_log` | `log`（hash・日時・作者・件名の決まった形） | 始まりか範囲 `A..B`、パス、件数（1〜200、既定 30）、飛ばす数、日付の範囲、作者と件名の文字列（固定の文字列として）、変更したファイルの一覧の有無 |
| `git_show` | `show --stat --patch`、または `show <rev>:<file>` | revision、diff を絞るパス、または古い版を見るファイル |
| `git_blame` | `blame` | ファイル、revision、行の範囲 |

- revision は英数字と `_ . / ~ ^ -` だけで、`-` で始まらない（範囲は `git_log` だけ）。パスはリポジトリからの相対で、`..` を含まない。pathspec は字のとおりに読む（`GIT_LITERAL_PATHSPECS=1`）。
- `--no-ext-diff`・`--no-textconv` を付け、hook も読まない。`-c` や外部の diff など、任意の git の引数は渡せない。
- 出力は上限の文字数で切り、切ったことを添える。時間の上限を超えたら止める。

### 作業領域の外を読ませない

`read`・`grep`・`find`・`ls` の `path` を、呼び出しの前に次のとおり判定する。外に出るものは止め、理由をモデルに返す。

- pi と同じように、全角などの空白を半角にし、先頭の `@` を外す。`~` と `file:` で始まるものは、それだけで止める（pi はホームなどに展開する）。
- context の作業領域（ホストの `contextWorkspace`、`<workDir>/<contextId>`）からの相対として解き、シンボリックリンクをすべて解いた先が、作業領域の実体の中にあること。
  まだ無いパスは、ある所までを解いて残りを付けて判定する。
- `path` を省いたとき（`grep`・`find`・`ls`）は作業領域そのものなので、通す。

clone はリンクを作らないので、作業領域の中にリンクはできない。判定とあわせて二重に守る。
`repositories.json` が読めない（JSON でない、値が正しくない）ときは、clone・履歴・時刻の道具を出さないが、この判定と `bash`・`edit`・`write` の遮断は働かせる。

## `repositories.json`

agentDir に置く。秘密は置かない。無いときは、clone と履歴の道具が出ず、上の判定と遮断もしない。

| 項目 | 既定 | 意味 |
|---|---|---|
| `clone.maxSizeMegabytes` | `1024` | 1 つの clone の大きさ（`.git` を含む）の上限 |
| `clone.maxTotalSizeMegabytes` | `3072` | 1 つの context の clone の合計の上限。`maxSizeMegabytes` 以上 |
| `clone.timeoutSeconds` | `300` | 1 回の clone の時間の上限 |
| `history.timeoutSeconds` | `120` | 1 回の `git_log`・`git_show`・`git_blame` の時間の上限。partial clone なので、古い版の中身を取りに行く時間を含む |
| `history.maxOutputCharacters` | `40000` | 履歴の道具の出力の上限 |

大きさは、clone の間 0.5 秒ごとと終わった後に、ディレクトリの大きさを数えて確かめる。履歴の道具が後から取ってくる中身は、合計の上限に数えない（次の clone のときに数える）。

## 汎用ホストの設定

`config.example.json` は、ADR 0019〜0021 の項目を書いている。猶予（`taskTimeLimitGraceSeconds`）はホストの既定（300 秒）のまま。

| 項目 | 値 | 意味 |
|---|---|---|
| `taskTimeLimitSeconds` | `3600` | 1 回の依頼の時間の上限（ADR 0019） |
| `maxConcurrentTasks` | `1` | 係全体で同時に走る依頼の数（ADR 0019）。2 に上げるのは、Plus の枠と Pod の資源の様子を見てから |
| `reports` | | レポートを保存する（ADR 0020）。`reports.dir` は書かず、既定の `<dataDir>/reports` に置く |
| `reports.web` | | 人用のページ（ADR 0021）。`port` は deploy の `reports` のポート（8081）と合わせる。`gated.jwksUrl` は gated の中央認証ホストの `/__gated/jwks.json`。gated の改修がそろうまで、overlay で Ingress を出さない |
| `contextWorkspace` | `mkdir -p` | context ごとの作業領域。clone はこの中に置き、context と一緒に消える |
| `piCommand` | | 上の「道具」のとおり、外す道具を `--exclude-tools` で渡す |

## 環境ごとの値

private の overlay（ADR 0010）で渡す。

- `deep-researcher-config` の `config.json` の `publicUrl`・`allowedCallers`・`reports.web` の値
- `web-research.json` の `searxng.url`
- image の tag（`ghcr.io/yuanying/fraction-agents-deep-researcher`）と、PVC の StorageClass
- 人用のページの Ingress・ホスト名・gated の NetworkRole（ADR 0021）と、レポートの置き場（`/data/reports`）の backup（ADR 0020）

ログインは、Wiki 管理人と同じ手順を係の Pod で行う（README の「ChatGPT Plus にログインする」。Pod は `deep-researcher-0`）。
