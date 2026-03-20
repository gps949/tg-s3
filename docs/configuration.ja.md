# 設定リファレンス

[English](configuration.md) | [中文](configuration.zh.md) | [日本語](configuration.ja.md) | [Français](configuration.fr.md)

## 環境変数

すべての設定は環境変数で行います。Docker デプロイの場合は `.env` ファイルに設定してください。手動デプロイの場合は `deploy.sh` が `.env` から読み取り、Cloudflare シークレットとしてプッシュします。

### 必須

| 変数 | 説明 | 例 |
|------|------|-----|
| `TG_BOT_TOKEN` | @BotFather から取得した Telegram Bot API トークン | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `DEFAULT_CHAT_ID` | Telegram グループ/スーパーグループの Chat ID | `-1001234567890` |
| `S3_ACCESS_KEY_ID` | クライアント認証用の S3 アクセスキー | `myaccesskey` |
| `S3_SECRET_ACCESS_KEY` | クライアント認証用の S3 シークレットキー | `mysecretkey123` |
| `BEARER_TOKEN` | Bot Webhook 検証と内部認証用の共有シークレット | `random-string-here` |

### Cloudflare（Docker デプロイ）

| 変数 | 説明 | 例 |
|------|------|-----|
| `CLOUDFLARE_API_TOKEN` | CF API トークン（Docker では必須、手動では任意） | `cf-api-token...` |
| `CF_ACCOUNT_ID` | CF アカウント ID（未設定の場合は自動検出） | `abc123def456` |
| `CF_CUSTOM_DOMAIN` | Worker のカスタムドメイン | `s3.example.com` |

### VPS / プロセッサ（オプション）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `VPS_SSH` | VPS デプロイ用の SSH 接続文字列 | -- |
| `VPS_DEPLOY_DIR` | VPS 上のデプロイディレクトリ | `/opt/tg-s3` |
| `VPS_PORT` | プロセッササービスのポート | `3000` |
| `VPS_URL` | VPS プロセッサの公開 URL | -- |
| `VPS_SECRET` | Worker とプロセッサ間の認証シークレット | -- |
| `TG_LOCAL_API` | Telegram Local Bot API エンドポイント | `https://api.telegram.org` |

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

- **S3 クレデンシャル**は AWS SigV4 署名検証に使用されます。強力でランダムな値を設定してください。
- **BEARER_TOKEN** は Telegram Webhook 呼び出しと署名付き URL の生成を認証します。秘密に保管してください。
- **VPS_SECRET** は Worker からプロセッサへの通信を認証します。別のランダムな値を使用してください。
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
| ファイルアップロード | 50 MB（Bot API） / 2 GB（Local Bot API） |
