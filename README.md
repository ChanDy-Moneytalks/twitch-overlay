# Twitch配信ゲーム情報オーバーレイ

配信中にTwitchのカテゴリで選んでいるゲームを自動検知し、カバー画像・タイトル・ジャンル・概要・価格（セール情報込み）をOBSに表示するオーバーレイです。

## 仕組み

```
GitHub Actions（5分おき）
  → Twitch API で現在のカテゴリ(ゲーム)を取得
  → Steam APIでタイトル・ジャンル・価格・セール情報を取得（初回はゲーム名でマッチングし、結果をFirestoreにキャッシュ）
  → Firestore (overlay/current) に書き込み
Firebase Hosting上の index.html
  → Firestoreをリアルタイム購読して即座に表示更新
OBS
  → ブラウザソースとしてHostingのURLを読み込むだけ
```

Steamで見つからないカテゴリ（Just Chatting、IRLなど）のときはカードを自動的に非表示にします。

## セットアップ手順

### 1. Firebaseプロジェクトを作成

1. https://console.firebase.google.com/ で新規プロジェクトを作成
2. 「Firestore Database」を本番モードで有効化（リージョンは asia-northeast1 推奨）
3. 「Hosting」を有効化
4. 「プロジェクトの設定 → 全般 → マイアプリ」でウェブアプリを追加し、表示される `firebaseConfig` の値を控える

### 2. index.html にFirebase設定を反映

`public/index.html` 内の以下の部分を、手順1で控えた値に書き換えてください。

```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};
```

この値は公開情報（クライアント用の識別子）なので、GitHubに公開してもセキュリティ上問題ありません。実際のアクセス制御はFirestoreのルール（`firestore.rules`）側で行っています。

### 3. サービスアカウントキーを生成

1. 「プロジェクトの設定 → サービスアカウント」タブ
2. 「新しい秘密鍵の生成」でJSONファイルをダウンロード
3. ターミナルで以下を実行してbase64文字列に変換（PowerShellの場合）

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("ダウンロードしたファイル.json")) | Set-Clipboard
```

クリップボードにコピーされるので、そのままGitHub Secretsに貼り付けます。

### 4. Twitchアプリの認証情報

分析ダッシュボードプロジェクトで作成済みのTwitchアプリがあれば、そのClient ID / Client Secretをそのまま流用できます（このオーバーレイはユーザー認証not不要で、`client_credentials`グラントのみ使用するため、追加のスコープ設定は不要です）。
新規に作る場合は https://dev.twitch.tv/console/apps から作成してください。

### 5. GitHubリポジトリにSecretsを登録

リポジトリの `Settings → Secrets and variables → Actions` で以下を登録:

| Secret名 | 内容 |
|---|---|
| `TWITCH_CLIENT_ID` | TwitchアプリのClient ID |
| `TWITCH_CLIENT_SECRET` | TwitchアプリのClient Secret |
| `TWITCH_BROADCASTER_LOGIN` | 自分のTwitchユーザー名（ログインID、表示名ではなくURLに使われる方） |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | 手順3で作ったbase64文字列 |
| `FIREBASE_PROJECT_ID` | FirebaseプロジェクトID |

### 6. デプロイ

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # 作成したプロジェクトを選択
firebase deploy --only hosting,firestore:rules
```

デプロイ後、`https://<プロジェクトID>.web.app` がオーバーレイのURLになります。

### 7. 動作確認

1. GitHubリポジトリの「Actions」タブ → `Update Stream Overlay` → 「Run workflow」で手動実行
2. Firestoreコンソールで `overlay/current` ドキュメントが作成されているか確認
3. `https://<プロジェクトID>.web.app` をブラウザで開き、カードが表示されるか確認
   （Twitch側で配信カテゴリを何かのゲームに設定していないと非表示のままなので、事前にカテゴリ設定をしておいてください）

### 8. OBSに追加

1. ソース → 「ブラウザ」を追加
2. URL: `https://<プロジェクトID>.web.app`
3. 幅・高さ: 配信解像度に合わせる（例: 1920×1080）
4. 「シーン内にオーディオを制御」はOFFでOK
5. 背景は透過なので、そのまま他のソースの上に重ねて配置できます

カードは画面左下に固定表示されます。位置を変えたい場合は `public/index.html` の `#card` の `left` / `bottom` の値を調整してください。

## 補足

- 5分間隔はGitHub Actionsの仕様上、実際には数分〜十数分程度ずれることがあります。もっとリアルタイム性が必要な場合は間隔を狭めるより、配信開始時に手動でworkflow_dispatchを叩く運用も検討してください。
- Steamでのゲーム名マッチングは自動（完全一致→部分一致）です。マッチが誤っている場合はFirestoreの `steam_mappings/{game_id}` ドキュメントを手動で修正すれば、次回以降そのゲームは正しいAppIDが使われます。
