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

**app-web のURLは、まだどちらにも登録されていない。** 登録するまでGoogleサインインは
リダイレクトで失敗する。

| 場所 | 追加するもの |
|---|---|
| Supabase → Authentication → URL Configuration → Redirect URLs | `http://localhost:7380/auth/callback` と本番URLの `/auth/callback` |
| Google Cloud → OAuth クライアント → 承認済みのJavaScript生成元 | `http://localhost:7380` と本番オリジン |

現状の登録内容（`bombsquad.me`、`localhost:3000`、`universal-io://auth/callback`）は
api-gateway/docs/supabase-setup.md にある。**app-web の開発ポートは 7380 であり、
3000 ではない。**

## 7. 未確認

1. **上記のダッシュボード設定。** 未登録なら実際のサインインは通らない
2. **Supabaseの匿名サインインにIP単位のレート制限があった**ように、OAuthにも
   同種の制限がありうる。実運用で確認する
3. `guest` プランは存在しない（`free`/500・`standard`・`pro`・`team`・`enterprise`）。
   サインインしたユーザーは全員 free/500 から始まる
4. Apple ID とメールリンクは app-web では未実装（api-gateway 側にはメールリンクがある）
