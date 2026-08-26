# google-tasks-mcp-server

Google Tasks を操作する MCP サーバー。タスクリストとタスクの CRUD、完了トグル、並べ替え・移動、完了タスクの一括非表示を提供する。

Google 公式の Workspace MCP サーバー群（Gmail / Calendar / Drive など）には Tasks が含まれていないため、その穴を埋める目的で作った。

2 つの動作形態がある。ツール定義と Google API 呼び出しは `src/shared/` で共有している。

| 形態 | 実体 | 使える環境 |
| --- | --- | --- |
| **stdio 版** | ローカルの Node プロセス | Claude Code、Claude Desktop |
| **リモート版** | Cloudflare Workers | 上記に加えて claude.ai、**iOS / Android** |

モバイルから使うには、Anthropic のクラウドから到達できるリモートサーバーである必要があるためリモート版を用意した。Claude は認証なしのリモート MCP サーバーを受け付けないので、リモート版は MCP サーバー自身が OAuth 2.1 の認可サーバーとして振る舞う。

## 設計方針

- **認証情報はファイルで渡す。** GCP からダウンロードした `client_secret_*.json` のパスを環境変数で指定する。MCP の設定ファイルに Client Secret を平文で書かずに済む
- **初回認証は独立した CLI で行う。** MCP サーバーは stdout を JSON-RPC で占有しているため、ブラウザ起動やログが混ざるとプロトコルが壊れる。認証を `npm run auth` に切り出すことで衝突を避け、失敗時の切り分けも容易にした
- **スコープは Tasks のみ。** `https://www.googleapis.com/auth/tasks` だけを要求する
- **更新は `patch`。** `update` は未指定フィールドを消してしまうため、部分更新には常に `patch` を使う
- **Google API は `fetch` のみで叩く。** `@googleapis/tasks` と `google-auth-library` はいずれも Node 依存で Workers では動かない。実行時依存は `@modelcontextprotocol/sdk` と `zod` だけ
- **リモート版は Google のトークンを Claude に渡さない。** 本人確認は Google に委譲するが、得たリフレッシュトークンは Worker 側の暗号化された props に保管し、Claude には自前発行のトークンのみを渡す
- **リモート版は利用者を 1 アカウントに限定する。** 公開エンドポイントになるため、`ALLOWED_EMAIL` と一致しない相手は認可しない

## セットアップ

### 1. GCP の準備

1. [APIs & Services → Library](https://console.cloud.google.com/apis/library) で **Google Tasks API** を有効化する
2. [Credentials](https://console.cloud.google.com/apis/credentials) で **OAuth 2.0 クライアント ID** を作成する。アプリケーションの種類は **デスクトップアプリ**
   - デスクトップアプリ型は任意のループバックポートをリダイレクト先にできるため、リダイレクト URI の登録は不要
3. JSON をダウンロードする（`client_secret_xxx.json`）
4. OAuth 同意画面が「テスト」ステータスの場合、自分の Google アカウントをテストユーザーに追加する

### 2. ビルド

```bash
npm install
npm run build
```

### 3. 初回認証

`client_secret_*.json` のパスを指定して認証する。ブラウザが開くので同意する。

```bash
GOOGLE_TASKS_CLIENT_SECRET_PATH=~/path/to/client_secret_xxx.json npm run auth
```

トークンは `~/.config/google-tasks-mcp-server/token.json` に権限 `0600` で保存される。以降はリフレッシュトークンで自動更新されるため、この作業は初回のみ。

### 4. MCP クライアントに登録

Claude Code の場合:

```bash
claude mcp add google-tasks \
  -e GOOGLE_TASKS_CLIENT_SECRET_PATH=$HOME/path/to/client_secret_xxx.json \
  -- node /absolute/path/to/google-tasks-mcp-server/dist/index.js
```

`.mcp.json` に直接書く場合:

```json
{
  "mcpServers": {
    "google-tasks": {
      "command": "node",
      "args": ["/absolute/path/to/google-tasks-mcp-server/dist/index.js"],
      "env": {
        "GOOGLE_TASKS_CLIENT_SECRET_PATH": "/absolute/path/to/client_secret_xxx.json"
      }
    }
  }
}
```

## 環境変数

| 変数 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `GOOGLE_TASKS_CLIENT_SECRET_PATH` | ○ | — | GCP からダウンロードした `client_secret_*.json` のパス |
| `GOOGLE_TASKS_TOKEN_PATH` | | `~/.config/google-tasks-mcp-server/token.json` | 認証トークンの保存先 |

## ツール

`tasklist` は省略時 `@default`（既定のタスクリスト）を使う。

### タスクリスト

| ツール | 説明 |
| --- | --- |
| `list-tasklists` | タスクリストを一覧する。他ツールに渡す ID はここで得る |
| `get-tasklist` | タスクリスト 1 件を取得する |
| `create-tasklist` | タスクリストを作成する |
| `update-tasklist` | タスクリスト名を変更する |
| `delete-tasklist` | タスクリストを削除する（中のタスクも消える） |

### タスク

| ツール | 説明 |
| --- | --- |
| `list-tasks` | タスクを一覧する。期限・更新日時での絞り込みに対応 |
| `get-task` | タスク 1 件を取得する |
| `create-task` | タスクを作成する。`parent` 指定でサブタスクになる |
| `update-task` | タスクを部分更新する（指定した項目のみ変更） |
| `complete-task` | 完了・未完了を切り替える |
| `move-task` | 並べ替え、サブタスク化、別リストへの移動 |
| `delete-task` | タスクを削除する |
| `clear-completed-tasks` | 完了済みタスクを一括で非表示にする |

### 仕様上の注意

- **期限に時刻は保存されない。** `due` は RFC 3339 で渡すが、Google Tasks は日付部分のみ保持する
- **完了タスクの取得には `showHidden` が要る。** `showCompleted: true` だけでは他クライアントで完了したタスクが返らないため、本サーバーは `showCompleted: true` のとき `showHidden` を自動で補う
- **`clear-completed-tasks` は削除ではない。** 非表示になるだけで、`showHidden: true` で取得できる
- **期限フィルタは「指定日を含む」に補正している。** Google Tasks API の `dueMax` は日付単位で排他的で、当日 23:59:59 を渡しても当日期限のタスクが 1 件も返らない（翌日 0 時を渡す必要がある）。直感に反するため、本サーバーは `dueMin` / `dueMax` を日付境界に正規化し、どちらも指定日を含む挙動に揃えている

## リモート版（Cloudflare Workers）

モバイルから使う場合はこちら。

### 構成

```
Claude クラウド / モバイル
  └→ Worker
      ├ /.well-known/*, /authorize, /token, /register   ← OAuth 2.1 認可サーバー
      └ /mcp                                            ← MCP 本体（認証必須）
           └→ Google Tasks REST API
```

### 必要なもの

- **ウェブアプリ型**の OAuth クライアント（stdio 版のデスクトップ型とは別に作る）
  - 承認済みリダイレクト URI に `https://<Worker の URL>/callback` を登録する
  - ローカル検証もするなら `http://localhost:8787/callback` も登録しておく
- Cloudflare アカウント

### デプロイ

```bash
# KV 名前空間を作成し、出力された ID を wrangler.jsonc に記入する
npx wrangler kv namespace create OAUTH_KV

# wrangler.jsonc の GOOGLE_CLIENT_ID と ALLOWED_EMAIL を記入してからデプロイ
npx wrangler deploy

# シークレットは設定ファイルに書かず Cloudflare 側に登録する
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

初回デプロイ時に workers.dev のサブドメイン登録を求められることがある。これはアカウント全体で 1 つの設定なので、プロジェクト名ではなく自分を表す名前にする。

### ローカルでの動作確認

```bash
# .dev.vars に GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ALLOWED_EMAIL を記入する
npx wrangler dev --port 8787 --local
```

`compatibility_date` はローカルランタイムが対応する日付に合わせること。未来の日付を指定すると起動に失敗する。

### Claude への登録

**モバイルアプリからは追加できない。** claude.ai か Claude Desktop で登録すると、同じアカウントの iOS / Android に同期される。

1. claude.ai の 設定 → コネクタ → カスタムコネクタを追加
2. URL に `https://<Worker の URL>/mcp` を入力（末尾の `/mcp` を忘れない）
3. 認証は「常に必須」、OAuth クライアントは「クライアント ID なし — 自動的に登録する」（どちらも自動検出される）
4. 「接続」から Google 認証を通す

### 踏んだ落とし穴

- **Google のリダイレクト URI の反映には時間がかかる。** 保存直後は `redirect_uri_mismatch` になることがある。数分待つ
- **Cloudflare は既定の User-Agent が Python のリクエストを 403 で弾く。** スクリプトから叩く場合は User-Agent を明示する

## 開発

```bash
npm run typecheck   # 型チェックのみ
npm run build       # dist/ に出力
npm run auth        # 初回認証
```

## ライセンス

MIT

## セットアップスクリプト

GCP コンソールでの操作（Tasks API の有効化、デスクトップアプリ型 OAuth クライアントの作成と JSON のダウンロード）を済ませたあと、残りをまとめて実行できる。

```bash
./scripts/setup.sh
```

`~/Downloads` から `client_secret*.json` を自動的に探し、種別を検証したうえで `~/.config/google-tasks-mcp-server/` に権限 600 で配置し、ビルド・初回認証・MCP サーバー登録まで行う。ファイルが別の場所にある場合はパスを渡す。

```bash
./scripts/setup.sh /path/to/client_secret.json
```
