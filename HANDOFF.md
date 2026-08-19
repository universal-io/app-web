# セッション引き継ぎ

**この1本だけを、常に次のセッションのためだけに保つ。**
役目を終えた記述は [docs/log.md](docs/log.md) へ移して、ここからは消す。
増やさない・分けない・積み上げない。現在の設計は
[README](README.md) から辿れる文書が正本で、ここはその上に乗る「いま何をすべきか」だけ。

最終更新: 2026-08-20

---

## 🔴 最初の一歩: ドメイン移行

**アプリを `universal-io.com` のルートに置き、製品サイトを下層へ移す**（決定済み。
ChatGPT が chat.openai.com → chatgpt.com へ移った側の設計。web版の存在意義は
「URLを開くだけ」で、URL がインストーラーそのものだから、住所は一等地に置く）。

- **製品サイトは `../web-product`**（別リポジトリ。中身は未調査）
- app-web の Vercel プロジェクトは `universal-io-app-web`

**触る外部設定は3つ。全部「毎回忘れる」領域なので auth.md §6 を読むこと。**

| 設定 | 場所 | 注意 |
|---|---|---|
| 承認済みJavaScript生成元 | Google Cloud の `Supabase Auth Client` | **`whatifepxyz@gmail.com` で開く**。他アカウントでは403 |
| Redirect URLs | Supabase | **クエリを付けない値を登録する**（照合は文字列全体） |
| CORS許可リスト | `../api-gateway`（別リポジトリ） | main への push が本番デプロイ |

未決: app-web 内部の `/` は現在2台構成の共有ページで、ソロモードは `/solo`。
ルートに来るのがどちらかは、移行と合わせて決める（主経路はソロモード）。

## 済んだこと（2026-08-20）

**認証は完了した。** 実機で次がすべて通った。

1. `/solo` からのGoogleサインイン（→ 質問・回答・枠まで到達）
2. Supabase の「Allow anonymous sign-ins」を無効化
3. Mac版のGoogleサインインが引き続き通ること

経緯と踏んだ罠は log.md。

## 手を出す前に知っておくべきこと

**やる前に読む。ここに書いてあることを再発見するのに、このセッションでは何度も時間を使った。**

| 事実 | なぜ重要か |
|---|---|
| **Google認証のGCPは `whatifepxyz@gmail.com`** | 他のアカウントでは**プロジェクトの存在すら見えない**（403）。「無い」と誤認して探し回った。README の「アカウントと外部サービス」が正本 |
| **app-web・api-gateway・app-mac は同一のSupabaseプロジェクト** | Googleサインインしたユーザーは**Mac版と同一アカウント・同一テナント・同一利用枠**。クライアント側で身元を作ってはいけない |
| **Gatewayは既に本番につながっている** | `api.universal-io.com` を叩き、テナント解決も使用量計上も通っている。「接続作業」は存在しない |
| **タブ共有だけがライブで見られる** | ウィンドウと画面全体は「行って戻る」。理由は [capabilities.md](docs/capabilities.md) §4 |
| **`getDisplayMedia` のピッカーは制御できない** | ペインを消せず、`displaySurface` のヒントも Chrome 151 は無視する |
| **座標に触るなら `../app-ios/docs/investigation-highlight-offset.md` を読む** | 解決済みの問題を一度解き直した。「要約に書いてあるから読んだことにする」が失敗の形だった |
| **`redirect_to` にクエリを付けない** | Supabase の許可リストは文字列全体で照合し、不一致は黙って Site URL（Mac版の着地点）へ落ちる。戻り先は sessionStorage で運ぶ（auth.md §3） |

## 落とし穴（このセッションで踏んだもの）

全件 [docs/log.md](docs/log.md) の「間違えた記録」にある。特に再発しやすいもの:

- **見て確かめないと分からない不具合が多い。** タップ位置が242pxずれていた件も、
  覆いが暗いページで逆に働いていた件も、描画して目で見るまで気づけなかった
- **`onClick={handler}` はクリックイベントを第1引数に渡す。** 引数を取る関数を
  そのまま渡すと事故る。TypeScriptでは見えない
- **検証スクリプトの失敗が、製品の故障の顔で現れる。** Supabaseの429（レート制限）が
  「回答が出ない」として観測された

## 検証

```bash
npm run dev                                  # 別ターミナルで
npm i --no-save playwright
node scripts/check-solo-buffer.mjs           # 3経路の通し検証（全項目通過が正常）
node scripts/measure-signature-drift.mjs     # 画面署名の実測
```

`/solo?debug` で現在のモード・取得経路・取得間隔・候補のdriftが見える。

**自動検証は認証を迂回している**（セッションをlocalStorageに置く）。
製品コードにテスト用の抜け道は入れていないので、**実際のサインインは手で確かめるしかない。**
