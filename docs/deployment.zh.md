# 部署指南

[English](deployment.md) | [中文](deployment.zh.md) | [日本語](deployment.ja.md) | [Français](deployment.fr.md)

## 部署层级

TG-S3 支持三个部署层级：

| 层级 | 组件 | 费用 | 功能 |
|------|------|------|------|
| 最小化 | CF Worker + D1 + R2 | $0/月 | S3 API、Bot、Mini App，文件最大 20MB |
| 标准 | 最小化 + VPS | 约 $4/月 | + 文件最大 2GB，媒体处理 |
| 增强 | 标准 + CF 付费计划 | 约 $9/月 | + 更高速率限制，更多 D1 查询 |

## 前提条件

1. **Telegram Bot** -- 通过 [@BotFather](https://t.me/BotFather) 创建，保存 token
2. **Telegram 群组** -- 创建群组或超级群组，将 bot 添加为管理员，获取 chat ID
3. **Cloudflare 账户** -- 在 [dash.cloudflare.com](https://dash.cloudflare.com) 注册
4. **Node.js 22+** -- wrangler CLI 所需（仅手动部署需要）

### 获取 Chat ID

临时将 [@userinfobot](https://t.me/userinfobot) 添加到群组中，它会回复 chat ID（一个负数，如 `-1001234567890`）。获取后将其移除。

### 创建 Cloudflare API Token

Docker 部署需要在 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建一个包含以下权限的 token：
- Account / Workers Scripts: Edit
- Account / D1: Edit
- Account / R2: Edit
- Account / Account Settings: Read

## 方法一：Docker 部署（推荐）

适合 VPS 部署，一条命令搞定一切。

```bash
# 克隆并配置
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
cp .env.example .env
```

编辑 `.env`，填写必要的值：

```bash
# 必填
TG_BOT_TOKEN=123456:ABC-DEF...
DEFAULT_CHAT_ID=-1001234567890
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
BEARER_TOKEN=a-random-secret-string
CLOUDFLARE_API_TOKEN=your-cf-api-token

# 可选：自定义域名
CF_CUSTOM_DOMAIN=s3.example.com
```

部署：

```bash
docker compose up -d
```

这将启动两个服务：
- **deploy** -- 将 Worker 推送到 Cloudflare（运行一次后退出）
- **processor** -- 处理大文件和媒体（持续运行）

查看部署日志：

```bash
docker compose logs deploy
```

### 更新

```bash
git pull
docker compose up -d --build
```

## 方法二：手动部署

### 仅 Cloudflare Worker（最小化层级）

```bash
npm install
cp .env.example .env
# 编辑 .env

./deploy.sh --cf-only
```

该脚本将执行以下操作：
1. 验证配置
2. 创建 D1 数据库并初始化 schema
3. 创建 R2 存储桶并设置生命周期策略
4. 在 Cloudflare 中设置所有 secrets
5. 部署 Worker
6. 注册 Telegram Bot webhook

### 配合 VPS（标准层级）

确保 `.env` 中包含 VPS 配置：

```bash
VPS_SSH=user@your-vps-ip
VPS_DEPLOY_DIR=/opt/tg-s3
VPS_PORT=3000
VPS_URL=https://vps.example.com:3000
VPS_SECRET=a-random-vps-secret
```

然后部署全部组件：

```bash
./deploy.sh --all
```

或单独部署 VPS：

```bash
./deploy.sh --vps-only
```

VPS 部署将执行以下操作：
1. 检查 SSH 连通性
2. 如需要则安装 Docker
3. 通过 rsync 上传 processor 文件
4. 构建并启动 processor 容器

## 部署后验证

### 验证 S3 访问

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

### 验证 Bot

在 Telegram 中向你的 bot 发送 `/start`，它应该回复欢迎消息。

### 验证 Mini App

向 bot 发送 `/miniapp`，或直接访问 `https://your-worker.workers.dev/miniapp`。

## 自定义域名

1. 在 Cloudflare DNS 中添加一条指向你的 worker 的 CNAME 记录
2. 在 Cloudflare 控制台中，进入 Workers & Pages > 你的 worker > Settings > Triggers
3. 添加自定义域名
4. 在 `.env` 中设置 `CF_CUSTOM_DOMAIN`，然后重新部署

## 故障排查

### Worker 无响应
- 使用 `npx wrangler tail` 查看实时日志
- 验证 secrets 是否已设置：`npx wrangler secret list`

### Bot 未收到消息
- 验证 webhook：`curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- 重新注册：`curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.workers.dev/bot/webhook&secret_token=<BEARER_TOKEN>"`

### D1 错误
- 检查数据库是否存在：`npx wrangler d1 list`
- 重新初始化 schema：`npm run db:init:remote`

### VPS processor 不可达
- 检查容器：`docker compose logs processor`
- 验证端口是否开放：`curl http://localhost:3000/health`
- 确保 VPS_URL 可从 Cloudflare Workers 访问
