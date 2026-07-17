# Now Playing Tag — 配信ゲーム値札オーバーレイ（誰でも使える版）

Twitchで配信カテゴリに設定しているゲームを自動検知し、カバー画像・タイトル・ジャンル・概要・価格（セール情報込み）を中古ゲームショップの値札風カードでOBSに表示するオーバーレイです。訪問者はTwitchでログインするだけで、自分専用の表示URLが発行されます。

## 全体像

```
index.html (ランディングページ)
  → 「Twitchでログイン」→ Twitchの認証画面 → 戻ってくる
  → ブラウザだけでトークンを検証し、Firestoreの channels/{Twitchユーザーid} に登録
  → 専用URL（overlay.html?u=Twitchユーザーid）を発行

GitHub Actions（10分おき）
  → 登録済み全チャンネルの配信中カテゴリをTwitchからまとめて取得（最大100件/回）
  → 前回と同じ内容ならFirestoreへの書き込みをスキップ（無料枠の節約）
  → 変化があった時だけ Steam検索 → 詳細取得 → overlay/{Twitchユーザーid} に書き込み

overlay.html?u=... (OBSに設定するURL)
  → 該当ドキュメントをリアルタイム購読して表示
```

Twitchログインは秘密鍵不要の「Implicit Grant」方式を使っているため、専用のバックエンドサーバーは不要です（今まで通りFirebase Hosting + Firestore + GitHub Actionsだけで完結します）。

## セキュリティ上の注意

この構成にはバックエンドサーバーが無いため、Twitchログインの「本人確認」を厳密にはできません（Firestoreのセキュリティルールでデータの形だけを検証しています）。扱っているのは「誰でも見られる配信カテゴリ情報」のみで、個人情報やアカウント操作は一切行わないため実害は小さいですが、念のため把握しておいてください。

## セットアップ手順

### 1. Twitchアプリの設定を追加

既存のTwitchアプリ（分析ダッシュボードと共用）の管理画面（https://dev.twitch.tv/console/apps ）を開き、「OAuth Redirect URLs」に以下を追加してください。

```
https://<あなたのFirebaseプロジェクトID>.web.app/index.html
```

（例: `https://gameintroduce-9d196.web.app/index.html`）

これが無いとTwitchログインが失敗します。

### 2. index.html にClient IDを設定

`public/index.html` 内の以下を、TwitchアプリのClient IDに置き換えてください（Client IDは公開情報なので埋め込んで問題ありません。Client Secretは絶対に書かないでください）。

```js
const TWITCH_CLIENT_ID = "YOUR_TWITCH_CLIENT_ID";
```

### 3. Firestoreルール・Hostingをデプロイ

```bash
firebase deploy --only hosting,firestore:rules
```

### 4. GitHub Secrets

これまでの設定から `TWITCH_BROADCASTER_LOGIN` は不要になりました（削除してOKです）。残り4つが登録されていればそのまま動きます。

| Secret名 | 内容 |
|---|---|
| `TWITCH_CLIENT_ID` | TwitchアプリのClient ID |
| `TWITCH_CLIENT_SECRET` | TwitchアプリのClient Secret |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | サービスアカウントキーのbase64文字列 |
| `FIREBASE_PROJECT_ID` | FirebaseプロジェクトID |

### 5. 動作確認

1. `https://<プロジェクトID>.web.app/` を開き、「Twitchでログインしてはじめる」を押す
2. Twitchのログイン画面が出るのでログイン
3. 戻ってくると専用URLが表示される
4. そのURLをOBSのブラウザソースに設定
5. GitHub Actionsの「Run workflow」を手動実行して、Firestoreの `overlay/{Twitchユーザーid}` にデータが入るか確認

## 今後、利用者が増えてきたら

- Firestoreの無料枠（読み取り5万件/日、書き込み2万件/日）に近づいてきたら、`.github/workflows/update-overlay.yml` の実行間隔（現在10分おき）をさらに緩めることで対応できます。
- 本格的にアクセスが増える場合は、Twitchのポーリングをやめて EventSub（Webhook形式のプッシュ通知）に切り替えるのが本筋の解決策ですが、その場合は常時起動するサーバー（Cloud Run等）が必要になり、現在の「サーバーレス・無料構成」からは外れます。
