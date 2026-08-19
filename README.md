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

本番: <https://universal-io-app-web-kaya-matsumotos-projects.vercel.app>

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
| **Vercel（app-web）** | プロジェクト `universal-io-app-web` | |

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
| [docs/companion-mode.md](docs/companion-mode.md) | コンパニオン（スマホ・タブレットで見る）の設計と、公開前に必ず戻ること |
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

## 動かす

```bash
npm install
cp .env.example .env.local   # Supabaseの2値を埋める
npm run dev                  # http://localhost:7380
```

**Googleサインインが必要。** 1回の質問がモデル呼び出し1回で実費が出るため、
アカウントに紐づけて計測する。**Mac版とまったく同じアカウント**（同一のSupabase
プロジェクト）なので、どちらでサインインしても利用枠と履歴は共通になる。

外部設定（Supabase の Redirect URLs と Google Cloud の承認済みオリジン）は
**2026-08-20 に登録済み**。触るときは [docs/auth.md](docs/auth.md) §6 を見ること
— **どのGoogleアカウントで開くか**が最初の関門になる。

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
node scripts/check-solo-buffer.mjs             # ソロモード3経路の通し検証（24項目）
node scripts/measure-signature-drift.mjs       # 画面署名の実測
```

ユーザーの Chrome を使うのでブラウザのダウンロードは不要。
`/?debug` で現在のモード・取得経路・取得間隔が見える。

---

## いま何が動いているか

| 形態 | 状態 |
|---|---|
| **本体**（`/`、1台で完結） | **主経路。**タブ共有ならこのページに留まったままライブで見て質問できる（[solo-mode.md](docs/solo-mode.md)） |
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
- **ユーザーの明示操作（指差し・丸囲み・質問）が回答スコープを決める。** 周辺情報に上書き権限はない
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

### ドメイン（次にやること）

**アプリを `universal-io.com` のルートに置き、製品サイト（`../web-product`）を
下層へ移す。** 決定済み・未着手。手順の入口は [HANDOFF.md](HANDOFF.md)。

### 各モードの未確認事項

[solo-mode.md §9](docs/solo-mode.md) と [companion-mode.md §5](docs/companion-mode.md) を参照。

### Gateway側

- **画像からの製品判定** — Skillの `detect` は `host`/`bundle_id` 依存で、web版では
  発火しない。Slack・GA4等の知識が注入されないまま
- **契約のバージョニング規律** — `focus_target`／`visual_selection_hint`／`selection`／
  `pointer` と4世代が同居している
