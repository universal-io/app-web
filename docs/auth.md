# 認証とアカウント — 現在の状態

**Googleサインイン必須。** 匿名利用は無い。
可否の根拠は [capabilities.md](capabilities.md)、決定の経緯は [log.md](log.md)。

---

## 1. 本家と同じアカウントである（作ったのではなく、そうなっている）

app-web・api-gateway・app-mac は**同一の Supabase プロジェクト**を指している。
したがって app-web でGoogleサインインしたユーザーは、Mac版とまったく同じ
`auth.users` の行であり、**同じテナント・同じ利用枠・同じ使用履歴**を共有する。

これは実装した機能ではなく、同じプロジェクトを指していることの帰結である。
**この客体を分けてはいけない。** クライアントが独自の身元を作った瞬間、
Mac版とweb版が別人になる。

| | 参照 |
|---|---|
| プロジェクト ref の一致条件 | `.env.example`（「Gateway と同じプロジェクトを指すこと」） |
| Gatewayの検証 | `Authorization: Bearer <Supabase access token>` を Gateway が検証し、テナント解決と使用量計上を行う |
| ローカル開発 | 既定で本番Gateway（`api.universal-io.com`）を見る。`localhost:7380` はCORS許可済み |

## 2. なぜログイン必須か

**1回の質問がモデル呼び出し1回であり、実費が出る。** 誰が開いたか分からないまま
使わせる形は、費用が青天井になる。かつてこの製品は「インストール・ログイン・
前準備ゼロ」を掲げていたが、**費用の裏付けのない体験は配れない**。

匿名サインインは廃止した。あわせて、匿名ユーザーが無制限に作れるという公開前の
懸念（[two-device-mode.md](two-device-mode.md) §5）も、匿名そのものが無くなったことで消えた。

## 3. 流れ

```
/  /solo  /watch/[roomId]     ← すべて RequireAccount の内側
      │ 未サインイン
      ▼
   SignIn（Googleボタンだけ）
      │ signInWithOAuth（prompt=select_account）
      ▼
   Google → Supabase → /auth/callback?next=…
      │ exchangeCodeForSession
      │ bs_initialize_current_user   ← §4
      ▼
   next へ戻す（安全な内部パスのみ。既定は /solo）
```

- **`prompt=select_account`** を付ける。アカウントを複数持つ人は、付けないと
  Googleが選んだ側で黙ってサインインしてしまう（app-mac も同じ指定をしている）
- **`next` は内部パスだけ通す。** 外部URLを許すと、サインインさせてから
  別サイトへ落とす導線になり、このサイトの信用を貸すことになる
- **スマホ側（`/watch`）にもサインインが要る。** 質問するのは見る側の端末で、
  枠を消費するのもそちら

## 4. サインイン後に必ず `bs_initialize_current_user()` を呼ぶ

このSupabaseプロジェクトは他の作業と共有されているため、**`auth.users` に
トリガーを置かない**という決定がある（api-gateway/docs/supabase-setup.md）。
テナントとエンタイトルメントは、各クライアントが自分で呼んで作る。

Gatewayも最初のリクエストで遅延プロビジョニングするが、**サインインの時点で
呼ぶ**。失敗したときに「アカウントを準備できませんでした」と言える場所は
そこしかなく、質問が失敗する形で現れるより早い。

## 5. トークンの扱い

**リクエストのたびに取り直す。** ページ読み込み時のトークンを使い回してはいけない
（有効期限は約1時間、このプロダクトはタブを開きっぱなしで使う）。
`accessToken()` が `getSession()` 経由で常に現在のものを返す。

セッションは `onAuthStateChange` で購読する。別タブでのサインアウトや
バックグラウンド更新があるため、読み込み時に読んだきりにすると、
存在しないアカウントに対してサインイン済みのUIを出し続けることになる。

## 6. 外部設定（ダッシュボード側。コードでは変えられない）

### 🔑 どのアカウントで開くか

**Google認証のGCPプロジェクトは `whatifepxyz@gmail.com` にある。**
他のアカウントでは**プロジェクトが存在すること自体が見えない**（`resourcemanager.projects.get`
が403になる）。README の「アカウントと外部サービス」が正本。

```
https://console.cloud.google.com/auth/clients?project=899703844772
```

クライアント名は `Supabase Auth Client`。同じプロジェクトの中に**OAuth同意画面**もある
（ユーザーに見えるアプリ名はそこで設定する。別プロジェクトで同意画面を整えても
何も起きない）。

**`matsumotokaya@gmail.com` の `My First Project` にある `universal-io` は
Gemini のAPIキーであって、認証とは無関係。** Google Cloud が「認証情報」という同じ
見出しに両方を並べているだけで、方向が逆（機械が機械を認証する／人がアプリに認証される）。

### 登録内容

**2026-08-20 に app-web のオリジンを追加し、同意画面も設定済み。**
それまでは `localhost:3000` と `bombsquad.me` の2つしか入っておらず、
`universal-io.com` からも app-web からもサインインできない状態だった。

### Supabase → Authentication → URL Configuration → Redirect URLs

| 値 | 用途 |
|---|---|
| `http://localhost:7380/auth/callback` | app-web のローカル開発 |
| `https://universal-io-app-web-kaya-matsumotos-projects.vercel.app/auth/callback` | app-web の現在の本番 |
| `https://app.universal-io.com/auth/callback` | 独自ドメインへ移したとき |
| `universal-io://auth/callback` | Mac版（既存） |

### Google Cloud → OAuth クライアント（`Supabase Auth Client`）

**承認済みのリダイレクトURI は Supabase のコールバック1つだけ**でよい。
各アプリのURLではない。すでに設定済み。

```
https://skcsbcyivjcvevxntvqa.supabase.co/auth/v1/callback
```

**承認済みのJavaScript生成元**に足す（サインインを開始するページのオリジン）:

```
http://localhost:7380                                              ← app-web ローカル
https://universal-io-app-web-kaya-matsumotos-projects.vercel.app   ← app-web 本番
https://universal-io.com                                           ← 製品サイト。未登録
```

Client ID と Secret は変わらないので、**追加するだけならMac版への影響は無い**。

> **app-web の開発ポートは 7380 であり、3000 ではない。**
> `api-gateway/docs/supabase-setup.md` の "Current web values" 節は
> `bombsquad.me` を本番として挙げているが、**それは古い**。本番は
> `universal-io.com` 系で、移行は2026-07-03に完了している（同ファイル冒頭に
> そう書かれており、同じファイルの中で矛盾している）。

## 7. 未確認（次にやること）

1. **🔴 実機でのサインイン通しテスト。** 外部設定は 2026-08-20 に済んだが、
   `/solo` で実際にGoogleサインインしてから画面共有・質問まで到達できたかは
   **まだ確認していない**。ここが次の最初の一歩
2. **Supabaseの「Allow anonymous sign-ins」を無効にする。** app-web はもう
   匿名を使っていないので、有効なままにしておく理由が無い（乱用対策になる）
3. **Mac版のGoogleサインインが引き続き通るか。** クライアントは差し替えず
   オリジンを追加しただけなので影響は無いはずだが、確認はしていない
4. OAuthにIP単位のレート制限があるか（匿名サインインにはあった）。実運用で確認する
5. `guest` プランは存在しない（`free`/500・`standard`・`pro`・`team`・`enterprise`）。
   サインインしたユーザーは全員 free/500 から始まる
6. Apple ID とメールリンクは app-web では未実装（api-gateway 側にはメールリンクがある）
