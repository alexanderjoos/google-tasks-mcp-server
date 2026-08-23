#!/usr/bin/env bash
# GCP から client_secret JSON をダウンロードしたあとの手順をまとめて実行する。
#
#   ./scripts/setup.sh [client_secret のパス]
#
# パスを省略した場合は ~/Downloads から自動的に探す。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$HOME/.config/google-tasks-mcp-server"
SECRET_DEST="$CONFIG_DIR/client_secret.json"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m警告:\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31mエラー:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------- 1. client_secret を見つける ----------
if [ $# -ge 1 ]; then
  SECRET_SRC="$1"
  [ -f "$SECRET_SRC" ] || die "指定されたファイルがありません: $SECRET_SRC"
elif [ -f "$SECRET_DEST" ]; then
  info "設定済みの client_secret を再利用します: $SECRET_DEST"
  SECRET_SRC="$SECRET_DEST"
else
  # 最も新しい client_secret*.json を拾う
  SECRET_SRC="$(find "$HOME/Downloads" -maxdepth 1 -name 'client_secret*.json' -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -1 || true)"
  [ -n "$SECRET_SRC" ] || die "client_secret*.json が ~/Downloads に見つかりません。
GCP コンソールでデスクトップアプリ型の OAuth クライアントを作成し、JSON をダウンロードしてください。
すでに別の場所にある場合は: ./scripts/setup.sh /path/to/client_secret.json"
  info "見つけました: $SECRET_SRC"
fi

# ---------- 2. 種別を検証する ----------
CLIENT_TYPE="$(node -e '
  const fs = require("fs");
  const json = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(json.installed ? "installed" : json.web ? "web" : "unknown");
' "$SECRET_SRC")"

case "$CLIENT_TYPE" in
  installed) info "デスクトップアプリ型の OAuth クライアントを確認しました" ;;
  web) warn "ウェブアプリ型の OAuth クライアントです。ループバック認証に失敗する可能性が高いため、デスクトップアプリ型の作成を推奨します。" ;;
  *) die "OAuth クライアント JSON として認識できません: $SECRET_SRC" ;;
esac

# ---------- 3. 安全な場所に配置する ----------
if [ "$SECRET_SRC" != "$SECRET_DEST" ]; then
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  cp "$SECRET_SRC" "$SECRET_DEST"
  chmod 600 "$SECRET_DEST"
  info "配置しました: $SECRET_DEST (権限 600)"
fi

# ---------- 4. ビルド ----------
cd "$REPO_DIR"
[ -d node_modules ] || { info "依存をインストールします"; npm install; }
info "ビルドします"
npm run build

# ---------- 5. 初回認証 ----------
if [ -f "$CONFIG_DIR/token.json" ]; then
  info "認証済みのトークンがあります。再認証する場合は $CONFIG_DIR/token.json を削除して再実行してください。"
else
  info "ブラウザを開いて認証します"
  GOOGLE_TASKS_CLIENT_SECRET_PATH="$SECRET_DEST" npm run auth
fi

# ---------- 6. MCP サーバーとして登録 ----------
if claude mcp get google-tasks >/dev/null 2>&1; then
  info "MCP サーバー 'google-tasks' は登録済みです"
else
  info "MCP サーバーとして登録します（scope: user）"
  claude mcp add google-tasks --scope user \
    -e "GOOGLE_TASKS_CLIENT_SECRET_PATH=$SECRET_DEST" \
    -- node "$REPO_DIR/dist/index.js"
fi

info "セットアップ完了。Claude Code を再起動すると google-tasks が使えます。"
