# 脆弱性への対応の係（vuln-responder）

本番のイメージの脆弱性を分析し、直す PR・版上げの PR・OpenVEX の注釈の PR を出すエージェントの定義（ADR 0028）。
汎用ホストの image で動き、GitHub への書き込みは github-writer の sidecar（ADR 0027）に頼む。

## ファイル

| ファイル | 置き場所 | 中身 |
|---|---|---|
| `AGENTS.md` | agentDir（`/agent`） | 依頼の形（解析と版上げの節）、分析の手順、直すか注釈にするかの決め方、直す PR と版上げの PR の作り方、状態の選び方、VEX の書き方、PR の本文、外の文章の扱い |
| `settings.json` | agentDir | モデルと、image に入った Pi パッケージの読み込み |
| `github-writer.example.json` | agentDir に `github-writer.json` として（sidecar にも同じもの） | 書いてよい 17 リポジトリと、その範囲（下の表）。ブランチはどれも `vuln-responder/`。context の準備で worktree を作るのは fleet-infra だけ。commit の名義は App の bot |
| `config.example.json` | `/etc/fraction-agents/config.json` | 汎用ホストの設定の例。呼び出し元、同時 1 件、60 分、worktree の command |

`kustomization.yaml` は、`AGENTS.md`・`settings.json` を ConfigMap `vuln-responder-agent-dir` に、
2 つの例を ConfigMap `vuln-responder-config` にする。`deploy/agents/vuln-responder` がこれを読む。

## 環境ごとの値

private の overlay（ADR 0010）で渡す。

- `config.json` の `publicUrl`
- `github-writer.json` の `workspace.commitIdentity`。App の bot の名前とメール（`<slug>[bot]`、`<bot の user ID>+<slug>[bot]@users.noreply.github.com`）にする
- GitHub App の秘密鍵。Secret `vuln-responder-github-app`（キー `private-key.pem`）を手で作る。git に置かない
- 要れば `github-writer.json` の `repositories[].reviewers`。係が PR を新しく作ったときに、そのログインにレビューを頼む（ADR 0027）。
  CODEOWNERS でレビューが自動で頼まれないリポジトリ（fleet-infra）に、レビューを受け持つ account のログインを書く。
  例には書いていない。頼めなくても PR はでき、失敗は github-writer のログに出る

App の ID（5493557）と installation の ID（175776468）、bot の名前とメールは秘密ではないので、例にそのまま書いている。
App の権限は Contents と Pull requests の write、Metadata の read だけである（Workflows は無い）。

## 書いてよい範囲

App のインストール先は All repositories である（2026-11-18、ADR 0028 の追記）。係が書けるリポジトリを決めるのは
github-writer の設定（`github-writer.json` の `repositories`）だけで、書いてよいのは次の 17 リポジトリである。
設定に無いリポジトリと、設定に書いた範囲の外を変えるブランチは push されない。
本番の設定は fleet-infra にある。リポジトリを足すときは、そこに足すだけでよい（App のインストール先は直さない）。

本番で動く自作のイメージのソースのリポジトリが設定に無いか、アーカイブ済みなら、集計役（vuln-tracker）が
メトリクス `vuln_tracker_responder_coverage_gap` を出し、アラート `VulnTrackerResponderCoverageGap` が鳴る（vuln-tracker の ADR 0016）。

| リポジトリ | 既定のブランチ | 範囲 |
|---|---|---|
| fleet-infra | main | `apps/`・`infrastructure/`・`security/vex/` の中だけ（`scripts/`・`secrets/` は不可） |
| k8s-manifests-fraction | master | cnidaria の版の場所: `porkadot.yaml` と `assets/kubernetes/manifests/addons/cnidaria/` の中だけ |
| hshelf・live・docker-nfs-server・natsumi-sshd・cnidaria-cni・gated・vuln-tracker・fraction-agents・penelope・llm-proxy・release-lag | main | `.github/` の外 |
| tumblr-like・docker-sshd・node-exporter-smartmon | master | `.github/` の外 |
| llm-wiki | main | `web/` の中だけ（`.github/` は不可） |

- ブランチの接頭辞 `vuln-responder/` と commit の作者 `fraction-vuln-responder[bot]` は、ソースのリポジトリの
  「直しの PR のマージですぐリリースする」ワークフロー（ADR 0029）が見る。変えるときはそちらも直す。
- fleet-infra の `scripts/update-*.sh` に版があり、スクリプトで manifest を作り直すもの（gated・vuln-tracker など）は、
  係は版上げの PR を出さず、上げる版と流すスクリプトを返事に書く。

## 動き

- 汎用ホストは context ごとに `/data/work/<contextId>` で pi を動かす。その前に workspace の command が、
  github-writer の mirror を追う永続の clone（`/data/repos/yuanying/fleet-infra.git`）から、
  `/data/work/<contextId>/yuanying/fleet-infra` に context のブランチ（`vuln-responder/<contextId>`）の worktree を作る
  （`github-writer.json` の `workspace.repositories`）。
- ほかの書けるリポジトリ（ソースのリポジトリと k8s-manifests-fraction）は、係が要るときに bash から
  `node /opt/fraction-agents/pi-package/bin/workspace.ts add . <owner>/<repo>` で同じ形の worktree を足す。
  永続の clone は context をまたいで共有する。context は対象ごとに 1 つなので、同じ対象の次の依頼は同じ worktree を使う。
- 書けないリポジトリ（外のイメージの上流など）は、係が作業ディレクトリに public の GitHub から clone して読む。
- github-writer の mirror は、2026-10-28 に当時の 15 リポジトリで 115MB ほどだった（大きいのは llm-wiki の 56MB と natsumi の 41MB）。
  今の 17 リポジトリでは測っていない。
  Pod の起動のたびに、fleet-infra を先頭に 1 つずつ GitHub から取り直す。mirror の emptyDir の上限（2Gi）と
  github-writer のメモリの上限（512Mi）は、そのときの測りでは足りていた。
- 聞き返しの道具（`ask_caller`）は外している。呼び出し元はプログラムで、答えられない。
- 同時に走るのは 1 件まで（`maxConcurrentTasks`）、1 件は最長 60 分（`taskTimeLimitSeconds`）。

## 直す PR を有効にする

ADR 0028 の「直す PR を有効にした」に書いた。係の側（AGENTS.md と github-writer の設定の例）はこの版で入っている。
環境の側で次を変える。

- overlay の `github-writer.json` を、この例の `repositories` と `workspace.repositories` にする
- remote base の `?ref=` とイメージの tag を、この変更の入った版にする
- 集計役（vuln-tracker）の依頼の `mode` を `fix` にする（`--responder-mode=fix`）
