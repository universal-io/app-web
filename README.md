# Universal I/O for Web（仮称）

**ブラウザだけで、いま見ている画面を分かってくれる相棒。**
インストールも設定もなく、リンクを開いて画面を選べば、AIが画面を読み、
質問に答え、次の一手を案内する。

タグラインは本家と同じ「**こころにメガネと杖を。**」。仕事をする上での様々なギャップ —
知識・経験・言語・文化だけでなく、認知特性や能力のギャップ — を埋める眼鏡のような
補助具を目指す。行政手続きが分からない高齢者、仕事を始めたばかりの若い人、何らかの
ビハインドを持つ人が使えること。同時に、能力の高い人がさらにハイパフォーマンスを
発揮するためのエンパワーメントでもあること。**補助具は当事者だけのものにした瞬間に
普及しない。眼鏡のように全員のものにする**（app-mac の投資家ピッチと同じ立場）。

本番: <https://universal-io.com>（このアプリがドメインのルートを持つ）

---

## 🔑 アカウントと外部サービス（毎回忘れるので最初に読む）

**このプロダクトの外部設定は、複数のGoogleアカウントに散っている。**
探し始める前にここを見ること。一度、OAuthクライアントを別プロジェクトで
探し回って見つけられなかった。

| 何 | どこ | 備考 |
|---|---|---|
| **Google認証（OAuth）のGCP** | **`whatifepxyz@gmail.com`** | ここ以外のアカウントでは**プロジェクトが存在すること自体が見えない**（403） |
| ↳ プロジェクト番号 | `899703844772` | `https://console.cloud.google.com/auth/clients?project=899703844772` |
| ↳ OAuthクライアント名 | `Supabase Auth Client` | Client ID は `899703844772-akc49a6icvjt6q7q44a9iqm6g80gjog4.apps.googleusercontent.com`（公開値） |
| ↳ OAuth同意画面 | 同じプロジェクト内 | ユーザーに見えるアプリ名はここで設定する |
| **Gemini APIキー** | `matsumotokaya@gmail.com` の `My First Project` | 認証とは無関係。Gateway の `GEMINI_API_KEY`。**「認証情報」に並んでいるが人のログインには使っていない** |
| **Supabase** | organization `whatif-ep` / project `bomb-squad` | ref は `.env.local` 参照。app-web・api-gateway・app-mac が共有 |
| **顧客向け問い合わせ先** | **`info@universal-io.com`** | 届け先は `matsumotokaya@gmail.com` |
| **Vercel（app-web）** | プロジェクト `universal-io-app-web` | **`universal-io.com` / `www` を持つ** |
| **Vercel（製品サイト）** | プロジェクト `web-product` | `/product/*` の中継先。**消さない・改名しない**（下記） |

**Client Secret は Google 側で再表示できない。** すでに Supabase に入っているので、
紛失したら新しいシークレットを追加してローテーションする。

**6か月使われないOAuthクライアントは削除対象になる**（Googleの通知あり、削除後30日は復元可）。

---

## ドキュメント

**すべてのドキュメントはここから辿れる。ここに無いものは存在しないか、
`docs/archive/` にある。**

| 読むもの | 何が書いてあるか |
|---|---|
| **[HANDOFF.md](HANDOFF.md)** | **次のセッションが最初に読む。いま何をすべきか。** セッションを始めるならここから |
| **このREADME** | 何を作るか・どう動かすか・いま何が動いているか |
| [docs/capabilities.md](docs/capabilities.md) | **やりたいこと・できること・できないこと。技術的な可否の正本。**新しい案を思いついたらまずここ |
| [docs/solo-mode.md](docs/solo-mode.md) | 画面を読む本体（`/`・1台で完結）の現在の設計。**主経路** |
| [docs/pointing.md](docs/pointing.md) | **指した場所の隣に答えが出る形の要件と規則。実装済み** — バブルに触るならここが正本 |
| [docs/companion-mode.md](docs/companion-mode.md) | コンパニオン（スマホ・タブレットで見る）の設計と、公開前に必ず戻ること |
| [docs/auto-copilot.md](docs/auto-copilot.md) | **自動コパイロット（伴走モード）の構想。未着手** — 着手前に必ずここから。最初の一歩は実装ではなく計測 |
| [docs/auth.md](docs/auth.md) | 認証とアカウント。**本家と同一のSupabaseプロジェクト**である理由と、外部設定 |
| [docs/log.md](docs/log.md) | 時系列の記録。**間違えた記録**が主な価値。普段は読まない |

### 他リポジトリ（座標に触るなら必読）

| 読むもの | 何が分かるか |
|---|---|
| `../app-ios/docs/investigation-highlight-offset.md` | ハイライトのズレの調査記録。**解決済み**。同じ問題を追うなら必読 |
| `../app-ios/docs/lessons-from-app-mac.md` §3〜§4 | 座標・画像の授業料。実測値つき。再導出しない |
| `../api-gateway/docs/api-contract.md` | Gatewayの契約（`pointer`・`annotations`・座標の注意事項） |
| `../api-gateway/docs/design-philosophy.md` | 思想の正本（世界モデル・ハーネスエンジニアリング） |

### ドキュメントの規律

1. **すべてこのREADMEからリンクされている。** 孤立した文書を作らない
2. **必要なものだけが存在する。** 役目を終えたものは `docs/archive/` に移し、
   索引から外す。アーカイブは掘り返す用で、参照はしない
3. **ドキュメントは現在の状態だけを書く。** 日付・経緯・「このセッションで決めたこと」を
   書かない。日記のように伸びていく文書を作らない
4. **時系列は [docs/log.md](docs/log.md) だけに置く。** 追記のみ、普段読まない
5. **引き継ぎは [HANDOFF.md](HANDOFF.md) の1本だけ。** 常に「次のセッションが
   何をすべきか」だけを書き、役目を終えた記述は log へ移してそこからは消す。
   引き継ぎ文書を増やさない・分けない・積み上げない

---

## ドメイン構成（`universal-io.com`）

**アプリがルートを持ち、製品サイトは `/product` にいる。**
web版の存在意義は「URLを開くだけ」で、URLがインストーラーそのものだから、
住所は一等地に置く（ChatGPT が chat.openai.com → chatgpt.com へ移った側の設計）。

| URL | 中身 | どこが配信するか |
|---|---|---|
| `universal-io.com/` | **アプリ本体** | このリポジトリ |
| `universal-io.com/product/*` | 製品サイト・料金・会社・法務 | **`../web-product`**（別リポジトリ・別Vercelプロジェクト） |
| `api.universal-io.com` | Gateway | `../api-gateway` |
| `dl.universal-io.com` | Mac版のDMG | R2 |

Vercel のマルチゾーン構成。[next.config.ts](next.config.ts) の rewrites が
`/product/*` を web-product の本番デプロイへ中継し、web-product 側は
`basePath: "/product"` で受ける。

**🔴 `web-product` の Vercel プロジェクトを消さない・改名しない。**
`/product/*` は今もそのプロジェクトから配信されている。中継先のURL
（`web-product-kaya-matsumotos-projects.vercel.app`）が**プロジェクト名を含む**ため、
改名すると中継が切れる。紛らわしいから消す、をやると製品サイトが全部消える。

**web-product の Deployment Protection は preview のみにしてある。**
既定の `all_except_custom_domains` だと中継元から取得できず、SSOのログイン画面が返る。

**`robots.txt` はこちら側にある**（[app/robots.ts](app/robots.ts)）。
ドメインのルートを持つ側でしか `/robots.txt` を出せない。sitemap は web-product 側。

### www ではなく apex を正にする（設定済み）

`universal-io.com` が Production で、`www` はそこへ **308（永続）**。**逆にしてはいけない。**
Supabase の Redirect URLs・Google の承認済みJavaScript生成元・`metadataBase`・sitemap の
すべてが apex で登録されており、www で開かれると `redirect_to` が許可リストと一致せず、
**黙って Site URL（`api.universal-io.com`）へ落ちる**。一度この向きにして実際に壊れ、
ログイン後 `api.universal-io.com/auth#` に着地した（[docs/log.md](docs/log.md)）。

永続にしてよいのは、住所を永久に畳む判断だから。**逆に `/solo`・`/watch` の
リダイレクトは307（一時）**にしてある（[next.config.ts](next.config.ts)）
— あのパスは将来別の用途に使うかもしれず、ブラウザキャッシュで不可逆にしたくない。

**🔴 向きを変えた直後は、ブラウザが古い永続リダイレクトを覚えている。**
apex→www を308で張ってから www→apex に反転すると、以前訪れた人のブラウザは
自分のキャッシュから apex を www へ飛ばし続ける。**Vercelの設定は正しいのに
症状が消えない**という形で現れるので、設定を疑って直し続けると時間を失う。

「apex に CNAME は置けないから www を使う」という一般論はここでは当てはまらない。
DNSは Cloudflare で、CNAME flattening により apex に CNAME が入って動いている。

## 言語（英語が正、日本語ブラウザは日本語で着地）

**アプリは単一URL。ロケールをパスに持たない。**
`/` だけがアプリの住所で、言語は住所ではなく人に属する属性として扱う。
これは製品サイトと意図的に違う（あちらは `/product` 英語・`/product/ja` 日本語）。
マーケサイトは検索エンジンと共有リンクのための資産なので言語ごとに別URLが必要だが、
アプリの**URLはインストーラーそのもの**なので、2つあってはならない。
ChatGPT・Claude・Linear などが揃って取っている分け方と同じ。

| | 決め方 |
|---|---|
| 明示的に選んだとき | Cookie `NEXT_LOCALE` が以後ずっと優先 |
| 未選択のとき | `Accept-Language` を q値順に解釈して一致した言語 |
| どちらも無いとき | **英語**（`defaultLocale`） |

**リダイレクトしない。** `/` → `/ja` を張ると、CDNやブラウザがそれをキャッシュして
全員が同じ言語に固定される。このドメインは apex↔www の永続リダイレクトで
一度この形の事故を起こしている（[docs/log.md](docs/log.md)）。同じURLのまま
交渉した言語で描画するので、構造的に起こらない。

**代償：`/` が静的ページでなくなる**（リクエストごとに言語を決めるため）。
このページは開いた直後に認証と `getDisplayMedia` を走らせるので、静的である価値は無い。

仕組みは製品サイトと同一（`next-intl`・`messages/{en,ja}.json`・`useTranslations`）。
違うのはルーティング戦略だけ。理由は [lib/i18n/routing.ts](lib/i18n/routing.ts) に書いてある。

**ロケールをパスに入れてはいけない理由が、もう2つある。**

- `/auth/callback` が動かなくなる。Supabase の Redirect URLs は文字列全体で照合し、
  不一致は黙って Site URL（`api.universal-io.com`）へ落ちる。`/ja/auth/callback` は
  まさにその不一致になる
- QRの `/companion/[roomId]` が2種類になる。PC側の言語が相手のスマホに
  引き継がれる／落ちるという問題が出る

**回答の言語もこれに従う。** Gateway の `preferences.output_language` は
ロケールから決まる（`outputLanguageFor`）。ここは日本語固定で書かれていて、
UIが日本語しか無いうちは見えない誤りだった。

### デザインは製品サイトを正本とする

トークン（`ink`/`iris`/`cyan` ほか）・フォント構成・ヘッダー・フッターは
`../web-product` の写し。**リポジトリが別なので import できない手写しのコピー**で、
`nav.*` と `footer.*` のメッセージキーも同じものを使っている。
片方を変えたら両方を変える。

**🔴 next/font の変数は `<html>` に置く。`<body>` に置くとサイト全体が無言で
既定フォントに落ちる。** Tailwind v4 の `@theme` は `--font-sans` を
`:root`（=`<html>`）に出力し、その値は `var(--font-geist-sans), …` なので、
`:root` から見えない場所で宣言すると値ごと無効になり、部分適用ではなく
`font-sans` が preflight の既定（`ui-sans-serif`）に落ちる。

**web-product が実際にこれを踏んでいて、指定フォントが一度も適用されていなかった**
（`459a52f` で修正済み）。**症状が「似ているが少し違う」としてしか出ないため、
片方だけを見ていては気づけない。** 同一のマークアップなのに CTA の幅が
188px と 196px で食い違ったことで初めて分かった。両リポジトリのどちらでも、
フォントのクラスを `<body>` に移したら同じことが起きる。

## トップページはデモである

`/` は大きく「**どこが分からない？**」とだけ問う。マウスを動かすと、実UIと同じ
覆いとスポットライトが現れ、指したもの（ヘッダーのロゴ・リンク・CTA・見出し・
ボタン・フッター）が**台本の3コマ**（説明 → 質問 → 回答）で自分を説明する。
余白を指せば「ここには何もありません」と答える。

製品の主張は「説明が要らない。指せば分かる」であり、トップページはそれを
**文章で書く代わりに動作でやってみせる**。これは実UIの行き先の予告でもある
（クリックだけでなく、ポインタが載った場所に説明が出る形へ）。

- 台本は [messages/](messages/) の `demo`。**モデルは呼ばない** — サインイン前・
  費用ゼロで動く必要があり、本物の呼び出しではそれができない
- 台本を本物の回答と誤認させないため、バブルには小さく「デモ」と記してある
  （見えない知識は疑えない、というファミリー共通の規則の適用）
- ホバーできる端末のみ（`(hover: hover) and (pointer: fine)`）。タッチでは出ない
- `prefers-reduced-motion` では完成形（3コマ全文）を静止表示
- 実装は [app/demo.tsx](app/demo.tsx)、解説対象の印は `data-demo` 属性
- **1回だけ再生して、そこで止まる。** カーソルが止まっているのに繰り返すのは、
  答えではなく動かないアニメーションに見える。指し直せばまた再生される

**本物も同じ形で答える**（[docs/pointing.md](docs/pointing.md) 実装済み）。
指した場所の隣にバブルが出て、待つ間は「読んでいます…」、答えもそこに出る。
覆いとスポットライトの構成は [app/wash.ts](app/wash.ts) にあり、**デモと実UIで
共有**する — 別々に育つと「デモで見た体験」が嘘になる。

## 動かす

```bash
npm install
cp .env.example .env.local   # Supabaseの2値を埋める
npm run dev                  # http://localhost:7380
```

**ブラウザの言語設定で表示言語が変わる。** 日本語で見たいのに英語で出るときは、
ブラウザの言語設定か、ヘッダーの言語切替（Cookieに残る）を見ること。

**Googleサインインが必要。** 1回の質問がモデル呼び出し1回で実費が出るため、
アカウントに紐づけて計測する。**Mac版とまったく同じアカウント**（同一のSupabase
プロジェクト）なので、どちらでサインインしても利用枠と履歴は共通になる。

外部設定（Supabase の Redirect URLs と Google Cloud の承認済みオリジン）は
**2026-08-20 に登録済み**（`universal-io.com` を含む）。触るときは
[docs/auth.md](docs/auth.md) §6 を見ること — **どのGoogleアカウントで開くか**が
最初の関門になる。

Gatewayは既定で本番（`api.universal-io.com`）を見る。`localhost:7380` はGateway側の
CORS許可リストに入っている。**Gatewayは `../api-gateway`（別リポジトリ）**で、
`main` へのpushが本番デプロイを意味する。

### ポート番号（7380）について

3000〜3010 は create-next-app・Vite・Express の既定値で、**JSエコシステム全体が
取り合う帯域**である。実際、app-webを最初に起動したとき3001は別プロジェクト2つに
占有されており、画面には無関係なアプリが表示された（起動失敗が「動いているように
見える」形で現れる、たちの悪い症状）。

そのため 10000未満で衝突しない帯を使う。基点は `IO` のASCIIコード（73, 79）。

| ポート | 用途 |
|---|---|
| 7380 | **app-web（このリポジトリ）** |
| 7379 | Gateway をローカルで動かす場合の予約 |

macOSでは 5000・7000 を AirPlay Receiver が使い、49152以降はOSが外向き接続へ
割り当てるため、いずれも避ける。

### 検証

```bash
npm run dev                                    # 別ターミナルで
npm i --no-save playwright
node scripts/check-solo-buffer.mjs             # ソロモード4経路の通し検証
node scripts/measure-signature-drift.mjs       # 画面署名の実測
```

ユーザーの Chrome を使うのでブラウザのダウンロードは不要。
**通し検証は `locale: "ja-JP"` を指定して開いている** — 表示はブラウザの言語で
変わるので、指定しないと日本語の文言を英語のページに突き合わせることになる。
`/?debug` で現在のモード・取得経路・取得間隔が見える。

---

## いま何が動いているか

| 形態 | 状態 |
|---|---|
| **本体**（`/`、1台で完結） | **主経路。**タブ・ウィンドウ・画面全体のいずれもこのページに留まったままライブで見て指せる（[solo-mode.md](docs/solo-mode.md)） |
| **コンパニオン**（`/` の「スマホ・タブレットで見る」→ QR → `/companion/[roomId]`） | 別モードではなく同じ共有の第二の見口。作業画面を奪わないのが強み（[companion-mode.md](docs/companion-mode.md)） |
| アンビエント（音声＋VADで常時待機） | 未着手 |

### ファミリー内の位置づけ

| | app-mac（本家・配布済み） | app-ios | **app-web（これ）** |
|---|---|---|---|
| 導入 | DMGインストール＋権限設定 | App Store（予定） | **URLを開くだけ** |
| 対象OS | macOS | iOS/iPadOS | **すべて**（Windows含む） |
| 召喚 | ホットキーで即時 | アプリ起動 | タブを開いて画面を選ぶ |
| 画面の取得 | ScreenCaptureKit | カメラ / ミラー受信 | `getDisplayMedia` |
| AX実測座標 | ✅ | ミラー時のみ | ❌（画像のみ） |
| 実画面へのオーバーレイ | ✅ | ✅（ミラー映像上） | ❌（構造的に不可能） |

**web版はネイティブ版の代替ではなく、カバレッジの拡張である。**
詳細は [capabilities.md](docs/capabilities.md) §6。

---

## 変わらない規則（ファミリー共通）

- **AIプロバイダのAPIキーをクライアントに置かない。** モデル呼び出しは必ず自前サーバー経由
- **モデルを知るのはサーバーの1ファイルだけ**
- **どの操作も無音で終わらない** — 有限時間で結果か、原因を述べるエラーに到達する（app-mac R11）
- **ユーザーの明示操作（指差し・丸囲み・質問）が回答スコープを決める。** 周辺情報に上書き権限はない。web版では**画面共有の開始もこの明示操作に数え**、開始直後にシステムが初回説明を1回だけ送る（[docs/solo-mode.md](docs/solo-mode.md) §1）
- **注入している知識（パック/Skill）は必ずUIに表示する。** 見えない知識は疑うことも直すこともできない
- **画面画像・回答は保存しない**。usageには運用情報だけ
- **測ってから決める**

---

## 未解決のこと

### 🔴 座標精度

指した対象と返ってくる枠が一致しないことがある。画像サイズをモデルへ伝える修正は
入れたが、**その効果は未検証**。

**着手前に必ず上の「他リポジトリ」の2本を読むこと。**
一度これを読まずに独自の対処を作り、既に解決済みの問題を解き直した。
「要約に書いてあるから読んだことにする」が具体的な失敗の形だった。

最終解は**実測への接地**（`candidates` に実測矩形を渡す）。app-ios は OS の OCR で
解決し、モデルが+0.049外したプルダウンを+0.002で捉えた。**接地の価値は精度そのもの
より、精度が画像サイズ・解像度・画角から独立することにある。** web版の選択肢は
(a) WASM OCR をクライアントで動かす (b) Gateway側でOCR (c) モデルの目測のまま。未決。

なお **AX/DOMは一切使っていない**（`candidates` は常に空）。挙動がAXっぽく見えても
実体はビジョンのみ。

### 座標の検証の道具が無い

app-ios は「**サーバーが受け取ったバイトに、サーバーが返した座標で枠を描く**」道具で
1枚で決着させた。**座標については web 版に同等の手段が無い。**
ソロモードのバッファには道具を作り、実際に2つの誤りを暴いた（[log.md](docs/log.md)）。
同じことを座標にもやる。

### 各モードの未確認事項

[solo-mode.md §9](docs/solo-mode.md) と [companion-mode.md §5](docs/companion-mode.md) を参照。

### Gateway側

- **画像からの製品判定** — Skillの `detect` は `host`/`bundle_id` 依存で、web版では
  発火しない。Slack・GA4等の知識が注入されないまま
- **契約のバージョニング規律** — `focus_target`／`visual_selection_hint`／`selection`／
  `pointer` と4世代が同居している
