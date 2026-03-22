# 設定リファレンス

[English](configuration.md) | [中文](configuration.zh.md) | [日本語](configuration.ja.md) | [Français](configuration.fr.md)

## 環境変数

すべての設定は環境変数で行います。Docker デプロイの場合は `.env` ファイルに設定してください。手動デプロイの場合は `deploy.sh` が `.env` から読み取り、Cloudflare シークレットとしてプッシュします。

### 必須

| 変数 | 説明 | 例 |
|------|------|-----|
| `TG_BOT_TOKEN` | @BotFather から取得した Telegram Bot API トークン | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `DEFAULT_CHAT_ID` | Telegram グループ/スーパーグループの Chat ID | `-1001234567890` |

### 自動生成（手動設定不要）

| 変数 | 説明 | 生成元 |
|------|------|--------|
| `VPS_SECRET` | Worker とプロセッサ間の認証シークレット | `deploy.sh`（ランダム 48 文字） |
| `SSE_MASTER_KEY` | SSE-S3 サーバー管理暗号化の Base64 キー。deploy.sh が自動生成。 | `deploy.sh` |
| S3 認証情報 | S3 API 認証用のアクセスキー + シークレットキー | `deploy.sh`（D1 `credentials` テーブルに作成） |
| Webhook シークレット | Telegram Webhook 検証用シークレット | `TG_BOT_TOKEN` から HMAC-SHA256 で導出 |

S3 認証情報はデプロイ時に 1 回だけ表示されます。以後は Mini App の **Keys** タブで管理できます（作成、無効化、バケット別権限設定）。

### Cloudflare（Docker デプロイ）

| 変数 | 説明 | 例 |
|------|------|-----|
| `CLOUDFLARE_API_TOKEN` | CF API トークン（Docker では必須、手動では任意） | `cf-api-token...` |
| `CF_ACCOUNT_ID` | CF アカウント ID（未設定の場合は自動検出） | `abc123def456` |
| `CF_CUSTOM_DOMAIN` | Worker のカスタムドメイン（トンネルの自動作成も有効化） | `s3.example.com` |
| `CF_TUNNEL_TOKEN` | Cloudflare Tunnel コネクタートークン（CF_CUSTOM_DOMAIN 設定時に自動作成、または手動設定） | `eyJhIjo...` |

API トークン権限：Workers Scripts:Edit、D1:Edit、R2:Edit、Account Settings:Read。トンネル自動作成には追加で Cloudflare Tunnel:Edit と DNS:Edit が必要です。

### VPS / プロセッサ（オプション）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `VPS_SSH` | VPS デプロイ用の SSH 接続文字列 | -- |
| `VPS_DEPLOY_DIR` | VPS 上のデプロイディレクトリ | `/opt/tg-s3` |
| `VPS_PORT` | プロセッササービスのポート | `3000` |
| `VPS_URL` | VPS プロセッサの公開 URL（トンネル使用時は自動設定） | -- |
| `VPS_SECRET` | Worker とプロセッサ間の認証シークレット（自動生成） | -- |
| `TELEGRAM_API_ID` | Local Bot API 用の Telegram API ID（取得方法は下記参照）。2GB ファイルサポートを有効化。 | -- |
| `TELEGRAM_API_HASH` | Local Bot API 用の Telegram API Hash（取得方法は下記参照） | -- |

**TELEGRAM_API_ID と TELEGRAM_API_HASH の取得方法：**

1. https://my.telegram.org にアクセスし、電話番号でログイン
2. 「API development tools」をクリック
3. フォームに入力してアプリケーションを作成（以下のフィールドはメタデータのみで、機能には影響しません）：
   - **App title**：任意の名前、例：`tg-s3`
   - **Short name**：5-32 文字の英数字、例：`tgs3s`
   - **URL**：空欄
   - **Platform**：`Other` を選択
   - **Description**：空欄
4. 作成後、`api_id`（数値）と `api_hash`（文字列）を `.env` にコピー

### Worker ランタイム

`wrangler.toml` で vars またはバインディングとして設定します：

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `S3_REGION` | 報告する AWS リージョン | `us-east-1` |
| `WORKER_URL` | Worker の公開 URL（deploy.sh が自動設定） | -- |

### D1 と R2 バインディング

`wrangler.toml` で設定します：

```toml
[[d1_databases]]
binding = "DB"
database_name = "tg-s3-db"
database_id = "your-database-id"

[[r2_buckets]]
binding = "CACHE"
bucket_name = "tg-s3-cache"
```

## wrangler.toml

主要な設定セクション：

```toml
name = "tg-s3"
main = "src/index.ts"
compatibility_date = "2026-03-15"

[vars]
S3_REGION = "us-east-1"

[triggers]
crons = ["0 */6 * * *"]  # 6 時間ごとのメンテナンス
```

### Cron メンテナンスタスク

スケジュールハンドラーは 6 時間ごとに実行され、以下を処理します：

1. 期限切れの共有トークンをクリーンアップ
2. 孤立した共有トークンをクリーンアップ（オブジェクトは削除済みだが共有が残存）
3. 停滞したマルチパートアップロードをクリーンアップ（24 時間超過）
4. 孤立したチャンクをクリーンアップ
5. 期限切れのパスワード試行記録をクリーンアップ
6. 整合性チェック（オブジェクトを 50 件サンプリングし、Telegram ファイルへのアクセスを検証）
7. R2 キャッシュのクリーンアップ（D1 から削除されたオブジェクトを退避）

## セキュリティに関する注意事項

- **S3 認証情報**は D1 に保存され、AWS SigV4 署名検証に使用されます。高強度のランダム値が自動生成されます。Mini App の Keys タブで管理してください。
- **Webhook シークレット**は `TG_BOT_TOKEN` から HMAC-SHA256 で決定論的に導出されます。別の環境変数は不要です。
- **VPS_SECRET** は Worker からプロセッサへの通信を認証します。未設定時は自動生成されます。
- **CLOUDFLARE_API_TOKEN** は CF アカウントへの書き込み権限を持ちます。git にコミットしないでください。
- `.env` ファイルはデフォルトで `.gitignore` と `.dockerignore` に含まれています。

## レート制限

### Cloudflare 無料プラン

| リソース | 制限 |
|----------|------|
| Worker リクエスト | 100,000/日 |
| D1 読み取り | 5,000,000/日 |
| D1 書き込み | 100,000/日 |
| D1 クエリ/呼び出し | 50 |
| R2 Class A 操作（書き込み） | 1,000,000/月 |
| R2 Class B 操作（読み取り） | 10,000,000/月 |
| R2 ストレージ | 10 GB |

### Telegram Bot API

| リソース | 制限 |
|----------|------|
| チャンネルあたりのメッセージ数 | 約 20/分 |
| グローバルメッセージレート | 約 30/秒 |
| ファイルダウンロード | 20 MB（Bot API） / 2 GB（Local Bot API） |
| ファイルアップロード | 20 MB（Bot API、ダウンロード制限に合わせて） / 2 GB（Local Bot API） |
