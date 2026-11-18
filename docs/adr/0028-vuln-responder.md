# 0028. 脆弱性への対応の係（vuln-responder）: 分析して VEX の注釈を PR で出す

- Date: 2026-10-27
- Status: Accepted（2026-10-28 に直す PR を有効にした。「直す PR を有効にした」の節。2026-11-18 に GitHub App のインストール先を All repositories にした。「追記（2026-11-18）」の節）

## Context

本番のクラスタでは Trivy Operator がイメージの脆弱性を見つけ、集計役（vuln-tracker）が対応の段階と注釈を集めている。
注釈は fleet-infra の `security/vex/` に OpenVEX の文書として置き、書くのも直すのも PR で行う（fleet-infra の ADR 0001 と
`security/vex/README.md`）。いまは注釈を本人が手で書いている。

脆弱性ごとに、パッケージがイメージのどこから来たか、脆弱なコードが使われるか、上流は直したかを調べ、状態と理由と見直す期限を
決める作業は、ソースと上流の情報を読めばかなりの部分ができる。これを係にさせ、判断の質を本人が PR で見る。

決まっていることは次のとおりである。

- 集計役は、修正版がある Critical で、注釈が無く、新しいものを、対象ごとに 1 件の依頼にして A2A で送る。
  対象は「自作イメージのソースのリポジトリ」か「fleet-infra で動かしている外のイメージ」である。
  依頼は text の part に、対象・mode・脆弱性の一覧（版・イメージ・digest・段階・動いている場所）・VEX のファイル・返事の形を
  すべて書いて届く。同じ中身の data の part（`kind` が `vuln-triage/v1`）も付くが、汎用ホストはそれを pi に渡さない。
  contextId は汎用ホストが採番し、集計役はそれを対象ごとに覚えて、同じ対象の次の依頼を同じ context に続ける（vuln-tracker の ADR 0009）。
  同時に投げるのは 1 件までである。
- この係は CVE の説明や changelog のような信用できない外の文章を読む。書く先の fleet-infra は private で、ブランチ保護が無い。
  そのため GitHub への書き込みは、鍵を持つ sidecar（github-writer、ADR 0027）に代行させる。
- この係の GitHub App は fleet-infra だけにインストールされている。権限は Contents と Pull requests の write、Metadata の read である。
  （インストール先は後に All repositories にした。「追記（2026-11-18）」）

調べて分かったことは次のとおりである。

- 汎用ホストは、受け取ったメッセージの text と file の part だけを pi に渡す。data の part は捨てる。
- 門番（ADR 0009）の context ごとの worktree の command は、門番の設定にだけ対応していた。github-writer の係には使えなかった。
- fleet-infra は PR を merge commit でマージし、マージしたブランチを GitHub が自動で消す。
- 汎用ホストのイメージに jq と curl が無い。fleet-infra の注釈の検査（`scripts/check-vex.sh`）は jq を使う。

## Decision

### 役割: 分析して、VEX の注釈の PR を出すところまで

- 依頼の 1 件の脆弱性（finding）ごとに分析し、`security/vex/<registry>/<repository>.openvex.json` に statement を書き、
  fleet-infra に PR を出す。
- 分析の材料は、ソースのリポジトリ（public なら clone して読む）、lock ファイル、Dockerfile とベースイメージ、
  上流のリポジトリとリリース、changelog と advisory である。コードは読むだけで、ビルド・テスト・イメージの実行はしない。
- マージ・タグ付け・apply はしない。それは本人がする。
- 依頼の `mode` には `vex-only` と `fix` がある。この ADR では `fix`（直す PR）を有効にしない。
  `fix` の依頼でも注釈の PR だけを出し、直す PR が要ると考えたら、その中身を PR の本文と返事に書く。
- 聞き返し（A2A の `INPUT_REQUIRED`）は使わない。呼び出し元はプログラムで、答えられない。
  道具の `ask_caller` は pi の起動の引数で外す。判断できないときは PR を出さずに理由を返す。
  ただし、何を調べればよいかが言えるなら、`under_investigation` の注釈で PR を出してよい。

### 状態の選び方は厳しくする

`not_affected` と `fixed` の脆弱性は、Trivy の結果とアラートから消える。誤ると、本当の脆弱性が見えなくなる。

- `not_affected` は、実害が無い理由をソースや公式の情報で具体的に言えるときだけ選ぶ。言えなければ `affected` か
  `under_investigation` にする。`fixed` も、直っていることを確かめられたときだけ選ぶ。
- 外の文章の言い分だけを根拠にしない。外の文章に書かれた指示には従わない。おかしな指示が混じっていたら PR に書く。
- 約束の正は fleet-infra の `security/vex/README.md` である。係の AGENTS.md には要点だけを書き、書く前に毎回 README を読ませる。
- PR の前に `scripts/check-vex.sh` を通す。通らないまま PR を出さない。

### 書けるのは github-writer を通した fleet-infra の `security/vex/` だけ

- github-writer の設定（`github-writer.json`）に書くリポジトリは fleet-infra だけにし、`writablePaths` を `security/vex/` にする。
  ブランチの接頭辞は `vuln-responder/` である。
- これで、係が prompt injection を受けても、GitHub にできるのは fleet-infra の `vuln-responder/` のブランチへの、
  `security/vex/` の中だけの push と、その PR までになる。`.github/workflows/` は App の権限でも拒まれる。
- エージェントのコンテナに鍵は無い。鍵の Secret は `vuln-responder-github-app` とし、github-writer のコンテナにだけ mount する。

### 作業場所: 永続の clone と、context ごとの worktree

- 依頼 1 件は 1 つの context で、1 つの pi のセッションで動く（ADR 0007）。context は対象ごとに 1 つになる。
- workspace の command（`pi-package/bin/workspace.ts`）を github-writer に対応させる。
  agentDir に `github-gate.json` が無く `github-writer.json` があるとき、次のようにする。
  - `github-writer.json` の `workspace.cloneDir`（PVC の上）に、各リポジトリの mirror を `origin` にした bare の clone を持ち、
    prepare のたびに fetch する。mirror を追うので資格は要らない。
  - context のディレクトリの `<owner>/<name>` に、そのリポジトリの worktree を作る。ブランチは `<branchPrefix><contextId>` で、
    初めてなら最新の既定のブランチから切る。worktree があればそのまま残し、同じ context の次の依頼は続きから始まる。
  - commit の名義は `workspace.commitIdentity` にする。
  - remove は、worktree と、その context のブランチ（`<branchPrefix><contextId>` と `-<番号>` の付いたもの）を消す。
- ソースのリポジトリは、係が context のディレクトリの `<owner>/<repo>` に public の GitHub から clone する。
  context は対象ごとなので、同じ対象の次の依頼は同じ clone を使う。複数の対象で共有する永続の clone は、いまは持たない。
- `github-writer.json` の `workspace` は、エージェントの側の設定である。github-writer は読まない。

### マージや close の後は新しいブランチで続ける

- github-writer の拡張に、ブランチの最新の PR の状態（開いている・マージ済み・閉じた）を返す道具
  `github_pull_request_status` を足す。github-writer の PR の状態の口（ADR 0027）を使う。読むだけの道具である。
- 依頼のたびに、係はこの道具で状態を見る。
  - PR が無いか開いている: そのブランチで続ける。開いている PR には新しい commit が積まれる。
    集計役は、注釈がマージされるまで同じ finding をまた含めて頼むので、同じ PR を育てる形が合う。
  - マージ済みか閉じた: 最新の既定のブランチから、番号を足した新しいブランチ（`<branchPrefix><contextId>-2` など）で続ける。
    閉じた PR の commit は持ち込まない。
- 門番（ADR 0009）の「マージ・close の後は新しいブランチ」と同じ考え方である。門番は道具の中で自動で移るが、
  ここでは係が道具の答えを見て移る。

### 依頼は text を正として読む

- 係は依頼の text だけを読む。集計役の text の形（対象、`mode:` の行、「発見:」の一覧、「VEX のファイル:」の行）を AGENTS.md に書き、
  行の形が少し違っても意味で読ませる。人は形を決めずに text で頼める。
- 汎用ホストは変えない。data の part を pi に渡す変更は、この ADR では入れない。
  - 退けた案: 汎用ホストが data の part を JSON のコードブロックにして prompt に足す。集計役が text に同じ中身を書くので、
    この係には要らない。すべての係の入口を変えることになるので、data の part を読みたい係が出たときに別に決める。

### 呼び出し元と、同時の数と、時間

- 呼び出し元は、集計役の ServiceAccount（`system:serviceaccount:vuln-tracker:vuln-tracker`）と、本人の `owner`・`claude` である。
  集計役は ADR 0003 のとおり、projected token（audience `a2a`）を bearer で送る。
- 同時に働くのは 1 件まで（`maxConcurrentTasks: 1`、ADR 0019）。1 件は最長 60 分（`taskTimeLimitSeconds: 3600`）。

### イメージは汎用ホストのものに jq と curl を足して使う

- 新しいイメージは作らない。汎用ホストのイメージに jq（注釈の検査）と curl（advisory と changelog を読む）を足す。
- どちらも小さい。curl が無くても pi の bash から node の fetch で外を読めるので、ほかの係にできることは実質変わらない。

### manifest

- `deploy/agents/vuln-responder` に置き、github-writer の Component（ADR 0027）を足す。
- 環境の overlay が、namespace・イメージの tag・StorageClass、ConfigMap `vuln-responder-config`（`config.json` と
  `github-writer.json`）を渡し、Secret `vuln-responder-github-app`（`private-key.pem`）を手で作る。
- Service は `vuln-responder`（ポート 80）、ServiceAccount は `vuln-responder` である。
  集計役は、クラスタの中の `http://vuln-responder.<namespace>.svc/` に送る。

### 直す PR を有効にするとき

`fix` を有効にするときは、次を変える。

- github-writer の設定の `repositories` に、直す先を足す。
  - 自作イメージのソースのリポジトリ: `branchPrefix` は `vuln-responder/`。`writablePaths` は書かず、`readOnlyPaths` に `.github/` を入れる
    （App の権限でもワークフローは書けないが、規則でも止める）。
  - fleet-infra: `writablePaths` に、イメージの版を書く場所（`apps/`・`infrastructure/` のうち版上げで触るところ）を足す。
- GitHub App のインストール先に、それらのリポジトリを足す。本人が GitHub の画面で行う。
  （2026-11-18 から、インストール先は All repositories で、足す作業は要らない。「追記（2026-11-18）」）
- `workspace` の worktree は `repositories` の全部に作られる。リポジトリが多くなれば、対象のリポジトリだけに作るよう command を直す。
- AGENTS.md の「直す PR はまだ出さない」を改め、直す PR の作り方（依存の更新の仕方、テストを走らせられないこと、PR の本文）を書く。
- 集計役の依頼の `mode` を `fix` にする。

### 直す PR を有効にした（2026-10-28）

上の「直す PR を有効にするとき」に沿って、係の側を次のように変えた。環境の側（overlay の `github-writer.json`、版、
集計役の `mode`）は別に変える。

- **書ける先**: github-writer の設定の例を、App をインストールした 15 リポジトリにした（今の一覧は「追記（2026-11-18）」）。
  - 自作のイメージのソースのリポジトリ 12 個（hshelf・tumblr-like・live・docker-nfs-server・docker-sshd・node-exporter-smartmon・
    natsumi-sshd・cnidaria-cni・gated・vuln-tracker・fraction-agents・natsumi）は `readOnlyPaths: [".github/"]`。
  - llm-wiki は `writablePaths: ["web/"]` と `readOnlyPaths: [".github/"]`。イメージになるのは `web/` だけである。
  - fleet-infra は `writablePaths: ["apps/", "infrastructure/", "security/vex/"]`。`scripts/` と `secrets/` は書かせない。
  - k8s-manifests-fraction は、cnidaria の版の場所（`porkadot.yaml` と `assets/kubernetes/manifests/addons/cnidaria/`）だけ。
    cnidaria-cni の本番の版は、fleet-infra ではなくこのリポジトリにある。
  - 接頭辞はどれも `vuln-responder/`。commit の名義は App の bot（`fraction-vuln-responder[bot]`）で、例にも書いた。
    どちらも、マージですぐリリースする判定（ADR 0029）が見る。
- **worktree は要るリポジトリにだけ作る**: `workspace.repositories` に、context の準備で worktree を作るリポジトリを書けるようにし、
  例では fleet-infra だけにした。ほかのリポジトリは、係が bash から `workspace.ts add <dir> <owner>/<name>` で足す。
  - 理由: 15 リポジトリ（合わせて 115MB ほど）の worktree を context ごとに全部作るのは無駄が大きい。また、どれか 1 つの
    mirror がまだ無いだけで、すべての依頼の準備が失敗する。
  - 道具（Pi の拡張）にせず workspace の command に足したのは、準備と同じ処理（永続の clone、context のブランチ、名義）を
    そのまま使えるからである。bash には `PI_CODING_AGENT_DIR` と `FRACTION_AGENTS_CONTEXT_ID` がある。
  - 前に GitHub から clone したソースが同じ場所にあれば、worktree に置き換える。読むためだけの clone で、失うものは無い。
- **mirror の容量**: 15 リポジトリの bare の mirror は 115MB ほどで（2026-10-28 に測った。llm-wiki 56MB、natsumi 41MB）、
  1 つ 10 秒かからずに取れる。emptyDir の 2Gi と github-writer のメモリの 512Mi は変えない。
  起動の後の同期は設定の順に 1 つずつなので、fleet-infra を先頭に置いた。
- **AGENTS.md**: `mode: fix` の依頼を 2 つの節で読む（解析の `triage` と、版上げの `bump`。vuln-tracker の ADR 0011）。
  - 解析: ソースで直せるもの（lock の依存、ベースイメージ）は直す PR を出し、注釈は書かない。直せないものは注釈にする。
    lock は、コンテナにあるツール（npm）で install のスクリプトを走らせずに更新するか、公式の情報で全体を確かめられるときだけ手で書く。
    テストはリポジトリの README と CI に従って走らせ、走らせられなければ PR の本文に書く。
  - 版上げ: Renovate の PR で足りればその URL を返す。足りなければ fleet-infra の版（cnidaria-cni は k8s-manifests-fraction）を上げ、
    要らなくなる注釈を同じ PR で消す。全版を指す注釈を `fixed` にはしない。古い版が残っていても見えなくなるからである。
  - fleet-infra の `scripts/update-*.sh` に版があり、manifest を作り直すもの（gated・vuln-tracker など）は、`scripts/` を書けないので
    PR を出さず、上げる版と流すスクリプトを返事に書く。
  - cnidaria-cni は `porkadot.yaml` の `addons.cnidaria.image_tag` と、render 済みの manifest のイメージの 1 行を上げる。
    本人は porkadot の既定の版に従う方針なので、PR の本文に「一時の pin で、porkadot の既定が追いついたら外す」と書かせる。
    apply は本人が runbook で行う。
  - 返事の最初の行に、いちばん大事な PR の URL を書く。集計役は返事の最初の PR の URL を記録する。

### 注釈の product は既定で全版にする（2026-11-01）

係は `ghcr.io/yuanying/natsumi-workspace` の CVE-2026-33210（`ruby:4.0.9-slim-bookworm` に同梱の default gem の json。
Ruby 4.0 の修正版のベースイメージ待ち）を、v0.1.58 と v0.1.59 の digest 限定の statement で 2 度書いた（fleet-infra#276・#288）。
理由はどのタグでも同じなので、全版にすべきだった。自作のイメージは週次でリリースされ digest が変わるので、
digest 限定の注釈はすぐに当たらなくなる。2 度目の PR は、前の注釈が当たらなくなった理由を直さず、digest 限定をもう 1 つ足した。
AGENTS.md には「理由がタグをまたいで成り立つなら全版」と書いてあったが、どちらを選ぶかの基準が弱かった。

AGENTS.md の「5. 注釈を書く」の product の範囲を次のように強めた。

- 既定は全版にし、迷ったら全版を選ぶ。全版にするものを例で書いた: ベースイメージや言語のランタイムに同梱のもの
  （Ruby の default gem、Go の stdlib、OS のパッケージ）、上流の「どの版もまだ直っていない」のを待っているもの、
  実害が無く理由が設計によるもの。
- digest 限定は、その版だけの事情（外のイメージのこの版の修正待ちで、次の版で直ると分かっている、など）に限る。
- 依頼の発見が、前に書いた digest 限定の statement と同じ脆弱性・同じ理由で digest だけが違うなら、新しい digest 限定を足さず、
  全版の 1 つに書き換え、古い digest 限定を消す。
- 理由として、自作のイメージの digest が週次で変わることと、digest 限定の注釈が当たらなくなると集計役から同じ依頼が届き直すことを書いた。

全版の注釈は、古い版にも新しい版にも当たる。上流が直してベースイメージが新しくなれば、脆弱性はスキャンで出なくなり、
版上げの PR で要らなくなった注釈を消す（「版上げの PR」の手順 3）。全版の `fixed` は書かない、という決まりは変えない。

## Consequences

- 注釈の下書きを係が作り、本人は PR を見てマージするか直すかを決めるだけになる。判断の根拠は PR の本文に残る。
- 係が prompt injection を受けても、書けるのは fleet-infra の `security/vex/` の PR までである。
  ただし注釈の中身（例えば誤った `not_affected`）は検査で止まらない。それを止めるのは PR のレビューである。
- context のディレクトリに worktree とソースの clone が積もる。context の保持の期間が過ぎれば、ホストが消す。
- github-writer の mirror は Pod の emptyDir にあるので、Pod を作り直した直後は mirror ができるまで worktree を作れない。
  その間の依頼は失敗し、理由に「mirror がまだ無い」と出る。
- 係は text の形に頼る。集計役が text の形を変えたら、AGENTS.md の「依頼の形」を合わせる。
- 汎用ホストのイメージが jq と curl の分だけ大きくなる。

## 追記（2026-11-18）

GitHub App `fraction-vuln-responder`（App ID 5493557、installation 175776468）のインストール先を、選んだ 15 リポジトリから
All repositories に変えた。本人が GitHub の画面で行った。

- **理由**: 係が書けるリポジトリは、App のインストール先と github-writer の設定の `repositories` の 2 か所にあり、どちらも手で足していた。
  リポジトリを増やすたびに 2 か所を直す必要があり、入れ忘れが起きた（penelope・llm-proxy・release-lag が漏れていた）。
- **書ける先を決めるのは github-writer の設定だけになった**。本番の設定は fleet-infra にある。
  github-writer の絞り（ブランチの接頭辞 `vuln-responder/`、`writablePaths`・`readOnlyPaths`）は変えない。App に Workflows の権限は無いままである。
- **引き換え**: App の鍵が漏れたときに書ける範囲が、yuanying の全リポジトリに広がる。鍵は github-writer のコンテナにだけあり、
  係からは見えない（ADR 0027）。係が prompt injection を受けても、github-writer の設定の外には書けない。これを理由に受け入れた。
- **入れ忘れの見張り**: 集計役（vuln-tracker）が github-writer の設定を「係が書ける一覧」として読む。本番で動く自作のイメージの
  ソースのリポジトリが一覧に無い（`not-writable`）か、GitHub でアーカイブ済み（`archived`）なら、メトリクス
  `vuln_tracker_responder_coverage_gap` を出し、PrometheusRule `VulnTrackerResponderCoverageGap` が鳴る（vuln-tracker の ADR 0016）。
- **今の一覧**: github-writer の設定の例を本番に揃え、17 リポジトリにした。natsumi はアーカイブしたので外し、
  penelope・llm-proxy・release-lag を足した（どれも既定は main、`readOnlyPaths: [".github/"]`）。
- 「直す PR を有効にした」の mirror の容量（115MB）は、2026-10-28 の 15 リポジトリでの値である。今の一覧では測っていない。
