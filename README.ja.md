# TG-S3

**Telegramベースの S3 互換ストレージ -- Cloudflare Workers で動作**

[English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Français](README.fr.md)

---

TG-S3 は Telegram を S3 互換オブジェクトストレージバックエンドに変換します。ファイルは Telegram メッセージとして保存され、メタデータは Cloudflare D1 に格納、システム全体が Cloudflare Workers 上でランタイム依存なしに動作します。

## 機能

- **S3 互換 API** -- マルチパートアップロード、署名付き URL、条件付きリクエストを含む 27 のオペレーションをサポート
- **無制限の無料ストレージ** -- Telegram がストレージレイヤーを無料で提供
- **三層キャッシュ** -- CF CDN (L1) -> R2 (L2) -> Telegram (L3) による高速読み取り
- **Telegram Bot** -- Telegram から直接ファイル、バケット、共有を管理
- **Mini App** -- ファイルブラウザ、アップロード、共有管理を備えた Telegram 内蔵 Web UI
- **ファイル共有** -- パスワード保護、有効期限、ダウンロード制限、インラインプレビュー付き共有リンク
- **サーバーサイド暗号化** -- SSE-C（顧客提供キー）と SSE-S3（サーバー管理キー）に対応、AES-256-GCM 暗号化
- **大容量ファイル対応** -- オプションの VPS プロキシと Local Bot API により最大 2GB
- **メディア処理** -- VPS 経由で画像変換 (HEIC/WebP)、動画トランスコード、Live Photo 処理
- **マルチ認証情報** -- D1 ベースの認証情報管理、バケット別・操作別の権限設定
- **Cloudflare Tunnel** -- パブリックポートを公開せずに VPS へ安全に接続
- **多言語対応** -- Mini App は英語、中国語、日本語、フランス語をサポート
- **ゼロコストで開始** -- コア機能は Cloudflare 無料プランのみで動作

## アーキテクチャ

```
S3 クライアント ──┐
                  │
Telegram Bot ─────┤
                  ├──▶ Cloudflare Worker ──▶ D1 (メタデータ)
Mini App ─────────┤         │                R2 (キャッシュ)
                  │         │
共有リンク ───────┘         ▼
                       Telegram API ◀──▶ VPS プロキシ (オプション、>20MB)
```

**コンポーネント：**

| コンポーネント | 役割 | コスト |
|----------------|------|--------|
| CF Worker | S3 API ゲートウェイ、Bot Webhook、Mini App ホスト | 無料プラン |
| CF D1 | メタデータストレージ（オブジェクト、バケット、共有） | 無料プラン |
| CF R2 | 永続キャッシュ、<=20MB のファイル | 無料プラン (10GB) |
| Telegram | 永続ファイルストレージ（無制限） | 無料 |
| VPS + Processor | 大容量ファイル (>20MB)、メディア処理 | 約 $4/月（オプション） |

## クイックスタート

### 前提条件

- Node.js 22+
- [Telegram Bot](https://t.me/BotFather) とそのトークン
- Telegram グループ/スーパーグループ（[@userinfobot](https://t.me/userinfobot) で Chat ID を取得）
- [Cloudflare アカウント](https://dash.cloudflare.com)

### 方法 1: Docker（推奨）

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
cp .env.example .env
# .env を編集: TG_BOT_TOKEN、DEFAULT_CHAT_ID、CLOUDFLARE_API_TOKEN のみ必要
# 推奨: TG_ADMIN_IDS を設定して Bot アクセスを制限（カンマ区切りのユーザー ID）
./deploy.sh
```

スクリプトが環境を自動検出し、イメージのビルド、Worker のデプロイ、トンネル設定（`CF_CUSTOM_DOMAIN` 設定時）、サービスの起動をすべて処理します。S3 認証情報は Telegram Mini App の Keys タブで必要に応じて作成できます。

### 方法 2: 手動デプロイ（Docker なし）

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
npm install
cp .env.example .env
# .env を編集: TG_BOT_TOKEN と DEFAULT_CHAT_ID のみ必要

# デプロイ（環境を自動検出、すべてのシークレットを自動生成）
./deploy.sh

# （オプション）レガシー VPS SSH デプロイ
./deploy.sh --vps
```

### 動作確認

任意の S3 クライアントを Worker URL に向けます：

```bash
# AWS CLI を使用
aws configure set aws_access_key_id YOUR_KEY
aws configure set aws_secret_access_key YOUR_SECRET
aws --endpoint-url https://your-worker.workers.dev s3 ls

# rclone を使用
rclone config create tgs3 s3 \
  provider=Other \
  access_key_id=YOUR_KEY \
  secret_access_key=YOUR_SECRET \
  endpoint=https://your-worker.workers.dev \
  acl=private
rclone ls tgs3:default
```

## S3 互換性

オブジェクト CRUD、マルチパートアップロード、バケット管理、認証の 27 オペレーションをサポート。

| カテゴリ | オペレーション |
|----------|---------------|
| オブジェクト | GetObject, PutObject, HeadObject, DeleteObject, DeleteObjects, CopyObject |
| タグ | GetObjectTagging, PutObjectTagging, DeleteObjectTagging |
| 一覧 | ListObjectsV2, ListObjects (v1) |
| マルチパート | CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListParts, ListMultipartUploads |
| バケット | ListBuckets, CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation, GetBucketVersioning |
| ライフサイクル | GetBucketLifecycleConfiguration, PutBucketLifecycleConfiguration, DeleteBucketLifecycleConfiguration |
| 認証 | AWS SigV4（マルチ認証情報）、署名付き URL、Bearer トークン、Telegram initData |

**非対応（設計上の判断）：** バージョニング、ACL、クロスリージョンレプリケーション。詳細は [docs/S3-COMPAT.md](docs/S3-COMPAT.md) を参照。

## Telegram Bot コマンド

| コマンド | 説明 |
|----------|------|
| `/start` | ウェルカムメッセージ |
| `/help` | コマンドリファレンス |
| `/buckets` | 全バケット一覧 |
| `/ls <bucket> [prefix]` | オブジェクト一覧 |
| `/info <bucket> <key>` | オブジェクト詳細 |
| `/search <bucket> <query>` | オブジェクト検索 |
| `/share <bucket> <key>` | 共有リンク作成 |
| `/shares` | アクティブな共有一覧 |
| `/revoke <token>` | 共有を取り消し |
| `/delete <bucket> <key>` | オブジェクト削除（確認あり） |
| `/stats` | ストレージ統計 |
| `/setbucket <name>` | デフォルトバケット設定 |
| `/miniapp` | Mini App を開く |

Bot にファイルを送信するとデフォルトバケットにアップロードされます。

## ドキュメント

- [デプロイガイド](docs/deployment.ja.md)
- [設定リファレンス](docs/configuration.ja.md)
- [Bot コマンド](docs/bot-commands.ja.md)
- [S3 互換性](docs/S3-COMPAT.md)
- [アーキテクチャ設計](docs/design/00-overview.md)

## 技術スタック

- **ランタイム：** Cloudflare Workers（ランタイム依存なし）
- **データベース：** Cloudflare D1 (SQLite)
- **キャッシュ：** Cloudflare R2 + CF Cache API
- **認証：** AWS SigV4、署名付き URL、Bearer トークン
- **言語：** TypeScript（strict モード）
- **メディア処理：** Sharp + FFmpeg（VPS のみ）
- **ビルド：** wrangler v3

## ライセンス

MIT
