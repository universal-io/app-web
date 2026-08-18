# 要件定義 v0 — リポジトリ構成とGateway修正

作成: 2026-08-16 ／ ステータス: 決定案（実行は未着手・ユーザー承認待ち）

この文書はREADME・inception.mdに続く3本目。目的は2つ:
1. **リポジトリ構成をどう切るか**を決める（Gateway単独切り出しの是非）
2. web版開発を始める前に**Gatewayへ入れておくべき修正**を確定する

決定はここで行い、実行済みの内容だけがREADMEへ昇格する（inception.mdと同じ運用）。

---

## 1. 結論（サマリ）

| 決定事項 | 内容 |
|---|---|
| リポジトリ構成 | **Gatewayを`app-mac`から新規リポジトリへ切り出す**（例: `universal-io/gateway`）。app-mac・app-ios・app-web・web-productは今後も別リポジトリのまま。モノレポ化はしない |
| AIリクエスト経路 | 引き続き**1つのAPI**（マイクロサービス化しない。前セッションの結論を維持） |
| app-web | 新規リポジトリ（`universal-io/app-web`）。Gatewayを最初からリモートAPIとして呼ぶ |
| CORS | 前回「同一オリジンなら不要」と書いたが、**リポジトリを分ける以上デプロイも分かれるため、CORS実装は確定で必要** |
| 実行順序 | まずGateway単独切り出し（§4）→ Gateway契約修正（§5）→ app-web本体の実装 |

---

## 2. 現状把握（このセッションで確認した事実）

### リポジトリの実態

| リポジトリ | 中身 | 現在地 |
|---|---|---|
| `universal-io/app-mac` | macOSクライアント（`BombSquad/`）＋ **Gateway一式**（`web/`、`supabase/`） | 既存 |
| `universal-io/app-ios` | iOSクライアント＋独自の最小Gatewayプロトタイプ（`server/`） | 既存 |
| `universal-io/web-product` | 製品サイト（`universal-io.com`） | 既存・**サイトは既に別リポジトリという前例** |
| `universal-io/app-web`（予定） | 本企画 | 未作成（gitリポジトリですらない） |

### Gatewayが`app-mac`に同居していることの実害は、既に一度事故として発生している

`app-mac/AGENTS.md` 冒頭に恒久的な警告として記録されている:

> 2026-08-02〜03のセッションで、`web-product`向けのコミットが2回`app-mac`に入り、
> そのたびに`README.md`の無関係な変更が別物のコミットメッセージで記録された
> （どちらも`git reset --soft`で取り消し済み）

理由は「エージェントのシェルは作業ごとに`app-mac`へ戻る」ため、`cd`した直後でも次のコマンドでは`app-mac`にいる、という機構的な問題。**これは2リポジトリの時点で既に事故を起こしている。app-webが増えれば同じ罠がもう1箇所増える。**

### GatewayはmacOSクライアントとビルド時結合していない

`BombSquad.xcodeproj`のビルド設定（`project.yml`）・plistのどちらにも`web/`への参照はゼロ。Swift側は本番URL（`https://api.universal-io.com`）を叩くだけで、Gatewayのソースを必要としていない。**同居しているのはgitの歴史上の理由だけで、技術的な理由はない。**

### 直近のコミット履歴が示す実際の変更単位

直近50コミットのうち、`BombSquad/`と`web/`の**両方**に触れたコミットは**5件（10%）**。残り9割は片方だけで完結している。抽出した1件（`ce328d1`）を見ると、`web/`側だけの変更（Skillの追加）が`README.md`しか他に触っていない — つまり**大半の開発は最初からリポジトリが分かれていても困らない形で進んでいる**。

### 二重発明が既に実在する

`app-ios/server`は`/api/analyze`という**別のGateway実装**を持ち、認証・schema・context-packsが本家Gatewayと別物（inception.md §6で既出）。切り出し先の新リポジトリを「本家」として確定させることは、この二重発明を畳む前提条件にもなる。

---

## 3. リポジトリ構成 — 選択肢と判断

| 案 | 内容 | 判定 |
|---|---|---|
| A. 現状維持 | Gatewayは`app-mac`内、app-webは新規リポジトリでリモートAPIを叩く | 動きはするが、命名の矛盾（"Webの脳がMacアプリのリポジトリの中にある"）がクライアント4つ目（app-android）で悪化する一方 |
| **B. Gateway単独切り出し（推奨）** | `web/`+`supabase/`を新規リポジトリへ。各クライアントは全てそこを叩く | web-productの前例と同型。ビルド結合なし・コミットの9割が単独完結という実態に一致 |
| C. 全部モノレポ | 全クライアント＋Gatewayを1リポジトリに統合 | 却下。Swift/Kotlin/TSの混在、App Store審査とWeb即時デプロイという release cadence の違い、本番課金システムの巻き戻し困難な大移動になる。得られる利点（atomicな契約変更）は共有契約書＋PRレビューで代替可能 |

**Bを推奨する理由を、ゼロベースの問いに正面から答える形で言うと**: 今日ゼロから作るなら、Gatewayは「複数クライアントの共通基盤」という性質上、**最初からどのクライアントにも属さない独立リポジトリ**に置きます。`app-mac`に同居しているのは「macOSが最初のクライアントだった」という歴史の結果であり、複数クライアント前提の設計判断ではありません。web-productは既にこの形で正しく運用されている。

---

## 4. 移行手順（未実行・確認後に着手）

**リスクは低いと判定できます。** ビルド結合がなく、変更の9割が単独完結している以上、これは「作り直し」ではなく「置き場所を直す」だけの機械的な作業です。

1. `git subtree split`（または`git filter-repo`）で`app-mac`から`web/`と`supabase/`を**履歴ごと**新規リポジトリへ抽出
2. 移す文書を仕分ける（目安。実行時に個別判断）
   - 移す: `docs/api-contract.md`、`docs/design-philosophy.md`、`docs/supabase-setup.md`、`docs/admin-dashboard-plan.md`、`docs/guidance-accuracy-plan.md`、`docs/latency-plan.md`、`docs/reliability-hardening-plan.md`、`docs/vision-selection-evidence-fix.md`
   - 残す（macOSクライアント固有）: `docs/macos-ux-polish-checklist.md`、`docs/manual-golden-paths.md`、`docs/focused-vision-plan.md`、`docs/pitch/`
   - 要相談: `docs/universal-io-master-plan.md`（全社ロードマップなので、Gateway/クライアントどちらでもない3つ目の置き場所が要るかもしれない）
3. ~~本番デプロイの実態を先に確認する~~ → **確認済み（§8）**。同一Vercelプロジェクトの連携先を張り替えるだけでよく、ドメイン・環境変数・SSLは引き継がれる。**ディレクトリ名`web`は捨て、新リポジトリでは`gateway`またはルート直下に置く**（§9の誤解の原因を構造的に断つ）
4. 新デプロイ先で`api.universal-io.com`が正常に動くことを確認してから、`app-mac`側の`web/`・`supabase/`を削除する（**同一コミットにしない** — 切り分けて検証を挟む）
5. `app-mac/AGENTS.md`・`README.md`の「隣にもう1つリポジトリ」表を更新し、Gatewayリポジトリを追記
6. `app-web`を新規リポジトリとして`git init`し、Gatewayをリモート API として呼ぶ形で開発開始

**この手順はまだ実行していません。** 本番の認証・課金・quotaが乗っているため、実行前にユーザーの明示承認を取ります（デプロイ機構の実態確認が先に必要という点も含めて）。

---

## 5. Gatewayへ今のうちに入れておくべき修正

前回・前々回のセッションで洗い出した内容の確定版。§4の切り出しと同じタイミングか、切り出し直後の新リポジトリで着手するのが自然。

| # | 修正 | 理由 |
|---|---|---|
| A | vision結果に **`annotations[{box:{x,y,w,h} 正規化0-1}, label, kind]`** を追加 | web版はAXを持たず`target_candidate_id`だけでは指し示せない。app-iosの`schema.ts`から移植可能 |
| B | **`point`/`region`（正規化画像座標）を有効な選択入力として受理** | 現行`selection`はAXテキスト選択のみ正規化、region系は「受理して無視」。web版のクリック・丸囲みはAXでなく実際の指定なので、無視する根拠が異なる。既存の`VisionSelection`正規化層へ合流させる |
| C | **CORS実装** | リポジトリ分離＝デプロイ分離が確定したため、同一オリジン前提は使えない。許可オリジンのホワイトリスト＋SSEのプリフライト対応が要る |
| D | **匿名ゲスト認証の実装**（設計のみ存在、コード無し） | `bs_entitlements.plan`のCHECK制約に`guest`が無い、`bs_plans`にguest行が無い。マイグレーション2本＋プロビジョニング分岐が要る。レート制限も現状プロバイダの429転写のみで自前実装が無い |
| E | **画像からの製品判定**（Skillの`detect`が使えない） | web版はbundle_id/hostを名乗れない。2パス判定・1パス自己申告・ユーザー明示の3案から、実測して確定（前セッション§3参照） |
| F | **契約のバージョニング規律** | 現行visionには`focus_target`/`visual_selection_hint`/`selection`の3世代が同居。クライアントが増えるほど悪化するので、「受理して無視」に廃止期限をつける運用を今回から始める |

---

## 6. 未確認事項（実行前に要調査・要確認）

- ~~**本番デプロイの実際の仕組み**~~ → **2026-08-16 に Vercel MCP で確認済み（§8）**
- **`app-ios/server`のプロトタイプGatewayの扱い**。新Gatewayリポジトリを本家と確定させた後、これを畳むか実験用として残すかは別途決める（inception.md §7-1の残タスク）
- **`docs/universal-io-master-plan.md`の置き場所**。全社ロードマップなので、Gateway専用リポジトリに置くと逆に「クライアント側の計画が見えない」ことになりかねない

---

## 7. 次にやること

§3・§5の方針はユーザー承認済み（2026-08-16）。§8のデプロイ実態も確認済みのため、**§4の移行手順を実行できる状態**にある。

---

## 8. 本番デプロイの実態（2026-08-16、Vercel MCPで確認）

| 項目 | 値 |
|---|---|
| Vercel team | `kaya-matsumotos-projects`（`team_kV7X8asP6ThcbNj4UTaWNIz9`） |
| Vercelプロジェクト名 | **`universal-io-app-mac`**（`prj_be6Lu1yZv1uwZ9LQMy1M3pEgIzP0`） |
| 連携GitHubリポジトリ | **`universal-io/app-mac`**（repo id `1280866906`）、ブランチ`main` |
| **Root Directory** | **`web`**（ビルドログの`> web@0.1.0 build`で確定） |
| フレームワーク | Next.js 16.2.9 / Turbopack / Node 24.x |
| リージョン | `iad1`（米国東部） |
| 本番ドメイン | `api.universal-io.com` ＋ vercel.app系3つ |
| デプロイ方式 | GitHub連携（`source: git`）。`main`へのpushで自動デプロイ |

### 切り出し時の含意

**Vercelプロジェクトを作り直す必要はない。** 同一プロジェクトの Settings → Git で連携先を新Gatewayリポジトリへ張り替え、Root Directory を `web` から（新リポジトリの構成に応じて）ルートまたは相当パスへ変更するだけでよい。環境変数・ドメイン・SSL・ビルドキャッシュはプロジェクトに紐づくため引き継がれる。**`api.universal-io.com` のDNSを触る必要もない。**

ただし**プロジェクト名`universal-io-app-mac`は切り出し後に実態と合わなくなる**ので、リネーム（例: `universal-io-gateway`）を推奨する。Vercelのプロジェクト名変更は`*.vercel.app`のサブドメインを変えるが、`api.universal-io.com`はカスタムドメインなので影響しない。

### 副次的に判明した事項

- 🔴 **`universal-io/app-mac` は public リポジトリ**（`githubRepoVisibility: "public"`）。秘密情報の混入は**検査済みで問題なし** — `.env.local`はgit管理外（`.gitignore`と`web/.gitignore`の二重で除外）、トラックされているenv関連ファイルは`lib/env.ts`／`lib/server/env.ts`という型定義のみ。ただし**Gatewayを切り出す新リポジトリのvisibilityは、作成時に明示的に決めること**（本番の認証・課金・quotaロジックが入るため、privateを推奨）
---

## 10. M2 — 別デバイスパネル（2026-08-16 決定）

### なぜM1の形では足りないか

M1（PC内完結）を実機で動かして判明した構造的な問題:
**質問するUIが、監視対象と同じ画面の上にある。** 見られている側のPCで「この画面について
聞く」を押すという操作は、会議で言えば発表者が自分の共有画面を指差して自分に説明する形で、
役割が混線している。inception.md §7-3 が「PC内完結を先に作る」としたのは**実装が最小だから**
であって本命だからではなく、実際に触った結果、本命は別デバイス側だと確認された。

### 決定した形

| 役割 | 端末 | できること |
|---|---|---|
| **共有する側** | PC | 共有を開始・停止するだけ。作業画面を1ピクセルも奪わない |
| **見る側** | スマホ／タブレット | ミラーを見る → **その瞬間で止める** → 指して質問する |

**普段はミラーリング、質問したい瞬間だけ静止画に固定する。** 完全なリアルタイムに指を
差しても対象が動いて消えるため成立しない。この「固定してから指す」はM1と同一の仕組みで、
変わるのは**フレームの供給元**だけ。

### 決定事項

1. **固定するフレームはミラー映像をそのまま止める。** 共有元へ高解像度を要求しない
   （往復が入ると「その瞬間」がズレる）。inception.md §2 の実測でミラー経由でも日本語の
   小さい文字が判読できることは確認済み
2. **伝送路は WebRTC（P2P）、シグナリングは Supabase Realtime broadcast。**
   → **新しいサーバーを立てる必要がない。** 以前「唯一ほんとうに分けるべきもの」として
   挙げたWebRTC用の常駐サーバーは、Realtimeを使うことで不要になった。
   `@supabase/realtime-js` は `supabase-js` の依存として既に入っている。
   映像は端末間を直接流れ、こちらのサーバーを通らない（プライバシーとコストの両方で有利）
3. **プライバシー・認証は保留。** 「便利そうだ」を証明するまでは踏み込まない。
   見られる側と見る側は**同一人物**（会議に自分のPCとスマホの両方から入るのと同じ）
4. **Gatewayの変更は不要。** 質問するのは見る側の端末で、そこからは既存の
   `pointer` / `annotations` 契約をそのまま使う

### 未決（実装しながら決める）

- **ペアリングの方式。** 「同一人物・1アカウント」を実現する手段は決まっていない。
  スマホ側にログインを要求すると「準備ゼロ」が壊れるため、**PC側が部屋を作ってQRを表示し、
  スマホはURLで入る**形を推す（部屋の秘密はURLに載る）。この場合スマホ側は自分の匿名
  セッションでGatewayを呼ぶので、枠は質問した側が消費する
- **TURNサーバー。** 同一LANならP2Pはほぼ成功するが、別ネットワーク間やsymmetric NATでは
  中継が要る。v1では用意せず、失敗時に理由を表示する（無音で失敗させない）

### 🔴 公開前に必ず戻ること — 部屋コードの強度

2026-08-16、部屋IDを128bitのhexから**8文字（約39bit）へ意図的に弱めた**。

理由: **iOSはカメラから開いたリンクをSafariで開き、インストール済みのホーム画面アプリには
渡さない。** つまりホーム画面に追加した端末では、QRを読んでも当のアプリに入れない。
手で入力できるコードが唯一の確実な導線であり、hex 32文字は入力不可能だった。

39bitは「総当たりされない」水準ではない。**現在これが許容できるのは、部屋が一時的であり、
かつ見る側と見られる側が同一人物という前提（§10 決定事項3）があるからに過ぎない。**
他人に部屋を見せる段階へ進む前に、必ずこの判断を見直すこと。

### web版が構造的に持てないもの（記録）

「共有中インジケータのように、見ている画面へ常に付いて回る質問レイヤー」は
**ブラウザには作れない**（他アプリの上に描画できない）。これはネイティブ側の課題として
残す。別デバイス方式はその代替ではなく、**作業画面を奪わない点でむしろ優れている**。

---

## 9. Gatewayの所在（2026-08-16 検証）— 「webという名前」が誤解を生んでいる

切り出しを議論する前提として、3つの実体の対応を確定させた。

| GitHubリポジトリ | ディレクトリ | Vercelプロジェクト | ドメイン | 正体 |
|---|---|---|---|---|
| `universal-io/app-mac` | `BombSquad/` | （なし・Xcodeビルド） | — | macOSアプリ |
| `universal-io/app-mac` | **`web/`** | `universal-io-app-mac` | **`api.universal-io.com`** | **★Gateway＋認証UI＋管理画面＋課金** |
| `universal-io/web-product` | `src/` | `web-product` | `universal-io.com` / `www.` | マーケティングサイト |

**1つのリポジトリ（app-mac）が、macOSアプリとGatewayという技術的に無関係な2つを抱えている。**

### 根拠

- [app-mac/web/app/page.tsx](../../app-mac/web/app/page.tsx) のコメントがコード自身で宣言している:
  「web/ is the Gateway (API) + auth surface only. Product marketing and pricing live in web-product (universal-io.com).」`/`は`/auth`へリダイレクトするだけ
- `web-product`は**APIルートを1つも持たず**、package.jsonに`@supabase/supabase-js`も`stripe`も無い（依存は`motion`/`next`/`next-intl`/`react`のみ）。**認証を実装する手段を持っていない**
- `web-product`から Gateway への唯一の接点は料金ページの1行のみ:
  `const CHECKOUT_URL = "https://api.universal-io.com/billing/start"`（リンクで送り出しているだけ）

### 🔴 発見したドキュメントバグ（切り出しと同時に要修正）

[app-mac/web/README.md](../../app-mac/web/README.md) の冒頭が**事実と矛盾している**:

> このNext.jsアプリは、**製品サイト**、認証、アカウント、管理画面、本番AI Gatewayを所有します。

製品サイトは`web-product`へ分離済みで、この記述は分離前のまま取り残されている。**「webディレクトリ＝マーケティングサイト」という誤解の直接の原因。** Gatewayの所在が関係者に伝わっていないこと自体が、置き場所が間違っている証拠でもある。

### 切り出しへの含意

**ディレクトリ名`web`を捨て、新リポジトリでは`gateway`（またはリポジトリルート直下）にする。** 名前による誤解を構造的に断つ。§4の手順に反映済み。
