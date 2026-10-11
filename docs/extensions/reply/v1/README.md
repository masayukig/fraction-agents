# 返事の取り決め v1（reply v1）

fraction-agents のエージェントが、Task の返事を構造のある形でも返すための A2A の拡張。
決定の経緯は [ADR 0015](../../../adr/0015-reply-contract-as-an-a2a-extension.md)。

- 拡張の URI: `https://github.com/yuanying/fraction-agents/tree/main/docs/extensions/reply/v1`
- JSON Schema: [`reply.schema.json`](reply.schema.json)（このディレクトリ）
- 版は URI の末尾の `v1` で表す。形を変えるときは、新しい版（`v2`）を別の URI で出す。v1 の形は変えない。

## 形

返事は、どの相手でも次の 3 つの欄だけを持つ JSON のオブジェクトである。3 つとも必ず書く。ほかの欄は持たない。

| 欄 | 型 | 中身 | 上限 |
| --- | --- | --- | --- |
| `summary` | 文字列 | 答えそのもの。3 行以内の要約 | 1〜500 文字、3 行まで |
| `sections` | 配列 | 詳細。節ごとに `title` と `body` を持つ。読む順に並べる | 50 節まで。空でもよい |
| `sections[].title` | 文字列 | 節の題。1 行 | 1〜200 文字、改行なし |
| `sections[].body` | 文字列 | 節の本文。Markdown | 1〜50000 文字 |
| `sources` | 配列 | 出典。答えが拠ったページ | 100 件まで。空でもよい |
| `sources[].title` | 文字列 | ページの題。1 行 | 1〜300 文字、改行なし |
| `sources[].url` | 文字列 | `http` か `https` の URL。空白を含まない | 2000 文字まで |

- 文字数は文字（コードポイント）で数える。行は改行（LF）で区切る。
- 相手に固有のもの（読めなかったページ、添えた画像の名前など）は、節の 1 つとして書く。欄は足さない。

### 中身なし

`sections` が空の返事は「中身なし」とみなす（[ADR 0017](../../../adr/0017-news-agent.md)）。

- 相手は、知らせることが無いとき（ニュース係なら、新着の記事が無いときや、選んだ候補が無いとき）に `sections` を空にする。
  そのときも `summary` は書く（例「新着 0 件」）。
- 定期の依頼を送る呼び出し元（なつみの郵便ポスト）は、中身なしの返事を本人に知らせず、記録にも置かない。
- `sources` が空かどうかは、中身なしの判断に使わない。
- 形は変わらない（`sections` はもとから空でよい）ので、版は v1 のままである。
- 文章だけを返す相手（DataPart が付かない返事）は、中身なしを表せない。呼び出し元は、文章の返事を毎回中身ありとして扱う。

例（中身は架空）:

```json
{
  "summary": "東京は今日は晴れ、明日は朝から雨。",
  "sections": [
    { "title": "今日", "body": "晴れ。最高 25℃。" },
    { "title": "読めなかったページ", "body": "- https://news.example/a（ログインが要る）" }
  ],
  "sources": [{ "title": "天気の予報", "url": "https://weather.example/tokyo" }]
}
```

## 使い方（呼び出し元）

1. 相手の Agent Card の `capabilities.extensions` に、この URI があるかを見る。`required` は `false` であり、使わなくても依頼はできる。
2. `SendMessage` の要求で、A2A の service parameter `A2A-Extensions` にこの URI を書いて拡張を有効にする（JSON-RPC over HTTP では同じ名前の HTTP ヘッダ）。
   - `acceptedOutputModes` に `application/json` を書くだけでは有効にならない。形の取り決めは URI で結ぶ。
   - 答えを待っている Task（`INPUT_REQUIRED`）に答えるメッセージには、書かなくてよい。Task を始めた要求で有効にしていれば、その Task の返事に付く。
3. Task が `COMPLETED` になったら、`response` という名前の artifact を読む。
   - parts の 1 つ目は、いつもどおりの文章（TextPart、`text/plain`）。
   - 相手が取り決めの形で返事を出したときだけ、2 つ目に DataPart が付く。`data` が返事、`mediaType` は `application/json`。
     このとき artifact の `extensions` にこの URI が入る。
   - DataPart が無いときは、文章だけを読む（相手が取り決めの形で返事を出さなかった）。
4. 受け取った `data` は、`reply.schema.json` で検証する。合わなければ、文章の返事として扱う。

- 拡張を有効にした要求の応答には、`A2A-Extensions` ヘッダにこの URI が返る。DataPart が付いたかどうかは、artifact を見て判断する。
- 画像（[ADR 0012](../../../adr/0012-return-images-as-artifacts-by-uri.md)）は、今までどおり `response` の後の artifact で返る。この取り決めの外である。
- `COMPLETED` 以外（`FAILED`・`CANCELED`・`INPUT_REQUIRED`）では、DataPart は付かない。

## 文章の返事との関係

相手が取り決めの形で返事を出したとき、TextPart の文章は、その返事を Markdown にしたものになる。
拡張を有効にしていない呼び出し元にも、同じ文章が返る。

- 1 つ目の段落が `summary`。
- 節ごとに `## <title>` の見出しと、その下に `body`。
- 出典があれば、最後に `## Sources` の見出しと、`- [<title>](<url>)` の並び。

見出しで節に切り、先頭の段落を要約にすれば、DataPart を読まない呼び出し元でもおおよそ同じ形に戻せる。
本文の中に `## ` の見出しがあると節の切れ目が変わるので、元の形が要るときは DataPart を読む。
