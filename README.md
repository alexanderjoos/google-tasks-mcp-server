# google-tasks-mcp-server

Google Tasks を操作する MCP サーバー（stdio）。タスクリストとタスクの CRUD、完了トグル、並べ替え・移動、完了タスクの一括非表示を提供する。

Google 公式の Workspace MCP サーバー群（Gmail / Calendar / Drive など）には Tasks が含まれていないため、その穴を埋める目的で作った。

## 設計方針

- **認証情報はファイルで渡す。** GCP からダウンロードした `client_secret_*.json` のパスを環境変数で指定する。MCP の設定ファイルに Client Secret を平文で書かずに済む
- **初回認証は独立した CLI で行う。** MCP サーバーは stdout を JSON-RPC で占有しているため、ブラウザ起動やログが混ざるとプロトコルが壊れる。認証を `npm run auth` に切り出すことで衝突を避け、失敗時の切り分けも容易にした
- **スコープは Tasks のみ。** `https://www.googleapis.com/auth/tasks` だけを要求する
- **更新は `patch`。** `update` は未指定フィールドを消してしまうため、部分更新には常に `patch` を使う

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

## 開発

```bash
npm run typecheck   # 型チェックのみ
npm run build       # dist/ に出力
npm run auth        # 初回認証
```

## ライセンス

MIT
