# デプロイガイド

[English](deployment.md) | [中文](deployment.zh.md) | [日本語](deployment.ja.md) | [Français](deployment.fr.md)

## デプロイ構成

TG-S3 は 3 つのデプロイ構成をサポートしています：

| 構成 | コンポーネント | コスト | 機能 |
|------|----------------|--------|------|
| Minimal | CF Worker + D1 + R2 | $0/月 | S3 API、Bot、Mini App、最大 20MB のファイル |
| Standard | Minimal + VPS | 約 $4/月 | + 最大 2GB のファイル、メディア処理 |
| Enhanced | Standard + CF 有料プラン | 約 $9/月 | + 高いレート制限、D1 クエリ増量 |

## 前提条件

1. **Telegram Bot** -- [@BotFather](https://t.me/BotFather) で作成し、トークンを保存
2. **Telegram グループ** -- グループまたはスーパーグループを作成し、Bot を管理者として追加、Chat ID を取得
3. **Cloudflare アカウント** -- [dash.cloudflare.com](https://dash.cloudflare.com) でサインアップ
4. **Node.js 22+** -- wrangler CLI に必要（手動デプロイの場合のみ）

### Chat ID の取得

[@userinfobot](https://t.me/userinfobot) をグループに一時的に追加してください。Chat ID（`-1001234567890` のような負の数値）が返信されます。取得後は削除して構いません。

### Cloudflare API トークンの作成

Docker デプロイの場合、[Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) で以下の権限を持つトークンを作成してください：
- Account / Workers Scripts: Edit
- Account / D1: Edit
- Account / R2: Edit
- Account / Account Settings: Read

## 方法 1: Docker デプロイ（推奨）

VPS デプロイに最適です。1 コマンドですべてを処理します。

```bash
# クローンして設定
git clone https://github.com/pocketclouds/tg-s3.git
cd tg-s3
cp .env.example .env
```

`.env` に必要な値を記入します：

```bash
# 必須
TG_BOT_TOKEN=123456:ABC-DEF...
DEFAULT_CHAT_ID=-1001234567890
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
BEARER_TOKEN=a-random-secret-string
CLOUDFLARE_API_TOKEN=your-cf-api-token

# オプション：カスタムドメイン
CF_CUSTOM_DOMAIN=s3.example.com
```

デプロイ：

```bash
docker compose up -d
```

2 つのサービスが起動します：
- **deploy** -- Worker を Cloudflare にプッシュ（1 回実行後に終了）
- **processor** -- 大容量ファイルとメディア処理を担当（常駐）

デプロイログの確認：

```bash
docker compose logs deploy
```

### アップデート

```bash
git pull
docker compose up -d --build
```

## 方法 2: 手動デプロイ

### Cloudflare Worker のみ（Minimal 構成）

```bash
npm install
cp .env.example .env
# .env を編集

./deploy.sh --cf-only
```

スクリプトは以下を実行します：
1. 設定の検証
2. D1 データベースの作成とスキーマ初期化
3. R2 バケットの作成とライフサイクルポリシーの設定
4. Cloudflare へのシークレット設定
5. Worker のデプロイ
6. Telegram Bot Webhook の登録

### VPS 併用（Standard 構成）

`.env` に VPS 設定を追加してください：

```bash
VPS_SSH=user@your-vps-ip
VPS_DEPLOY_DIR=/opt/tg-s3
VPS_PORT=3000
VPS_URL=https://vps.example.com:3000
VPS_SECRET=a-random-vps-secret
```

すべてをデプロイ：

```bash
./deploy.sh --all
```

VPS のみを個別にデプロイ：

```bash
./deploy.sh --vps-only
```

VPS デプロイでは以下が実行されます：
1. SSH 接続の確認
2. Docker の自動インストール（必要に応じて）
3. rsync によるプロセッサファイルのアップロード
4. プロセッサコンテナのビルドと起動

## デプロイ後の確認

### S3 アクセスの確認

```bash
# AWS CLI
aws --endpoint-url https://your-worker.workers.dev s3 ls
aws --endpoint-url https://your-worker.workers.dev s3 mb s3://test
aws --endpoint-url https://your-worker.workers.dev s3 cp file.txt s3://test/

# rclone
rclone config create tgs3 s3 \
  provider=Other \
  access_key_id=YOUR_KEY \
  secret_access_key=YOUR_SECRET \
  endpoint=https://your-worker.workers.dev \
  acl=private
rclone ls tgs3:default
```

### Bot の確認

Telegram で Bot に `/start` を送信してください。ウェルカムメッセージが返信されれば正常です。

### Mini App の確認

Bot に `/miniapp` を送信するか、`https://your-worker.workers.dev/miniapp` に直接アクセスしてください。

## カスタムドメインの設定

1. Cloudflare DNS に Worker を指す CNAME レコードを追加
2. Cloudflare ダッシュボードで Workers & Pages > 対象の Worker > Settings > Triggers に移動
3. カスタムドメインを追加
4. `.env` に `CF_CUSTOM_DOMAIN` を設定して再デプロイ

## トラブルシューティング

### Worker が応答しない
- `npx wrangler tail` でライブログを確認
- シークレットが設定されているか確認：`npx wrangler secret list`

### Bot がメッセージを受信しない
- Webhook の確認：`curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Webhook の再登録：`curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.workers.dev/bot/webhook&secret_token=<BEARER_TOKEN>"`

### D1 エラー
- データベースの存在確認：`npx wrangler d1 list`
- スキーマの再初期化：`npm run db:init:remote`

### VPS プロセッサに接続できない
- コンテナの確認：`docker compose logs processor`
- ポートの確認：`curl http://localhost:3000/health`
- VPS_URL が Cloudflare Workers からアクセス可能であることを確認
