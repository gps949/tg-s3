# Telegram Bot 命令参考

[English](bot-commands.md) | [中文](bot-commands.zh.md) | [日本語](bot-commands.ja.md) | [Français](bot-commands.fr.md)

## 概述

TG-S3 bot 提供了通过 Telegram 管理 S3 存储的接口。所有命令均可在指定的存储群组中使用，也可在与 bot 的私聊中使用。

## 命令

### /start

显示欢迎消息，包含简要介绍和快速入门指南。

### /help

显示完整的命令参考，包含语法和示例。

### /buckets

列出所有存储桶及其对象数量和总大小。

```
/buckets
```

输出示例：
```
Buckets (3):
  default - 42 objects, 156.3 MB
  photos  - 128 objects, 1.2 GB
  backup  - 7 objects, 89.5 MB
```

### /ls

列出存储桶中的对象，支持按前缀筛选。

```
/ls <bucket> [prefix]
```

- 指定 bucket：列出该存储桶中的对象
- 指定 prefix：按键前缀筛选（效果类似目录列表）

示例：
```
/ls photos
/ls photos 2024/january/
```

### /info

显示特定对象的详细信息。

```
/info <bucket> <key>
```

输出内容包括：大小、内容类型、ETag、上传日期和存储桶名称。

### /search

按键名模式在指定存储桶中搜索对象。

```
/search <bucket> <query>
```

查询使用子字符串匹配方式对指定存储桶中的对象键名进行搜索。

### /share

为文件创建分享链接，支持可选的访问限制。

```
/share <bucket> <key>
```

可选参数可以追加在键名之后：

```
/share <bucket> <key> [过期秒数] [密码] [最大下载次数]
```

- **过期时间**：过期时长，单位为秒（默认：永不过期）
- **密码**：密码保护（默认：无）
- **最大下载次数**：下载次数限制（默认：无限制）

生成的链接格式：`https://your-worker.workers.dev/share/<token>`

分享链接支持以下路径：
- `/share/<token>` -- 带元数据的预览页面
- `/share/<token>/download` -- 直接下载
- `/share/<token>/inline` -- 内联显示（图片、视频）

### /shares

列出所有活跃的（未过期、未用尽）分享 token。

```
/shares
```

显示 token、关联文件、创建日期、过期时间、下载次数和密码状态。

### /revoke

撤销一个活跃的分享 token，使链接立即失效。

```
/revoke <token>
```

### /delete

从存储中删除一个对象。需要通过内联按钮确认。

```
/delete <bucket> <key>
```

删除操作是级联的：会移除 Telegram 消息、所有派生对象（缩略图、转码版本）、关联的分享 token 以及缓存条目。

### /stats

显示所有存储桶的存储统计信息。

```
/stats
```

输出内容包括：总对象数、总大小和存储桶数量。

### /setbucket

设置默认存储桶，后续接受可选 bucket 参数的命令将使用该存储桶。

```
/setbucket <name>
```

### /miniapp

打开 Telegram Mini App 内联界面，提供图形化的完整文件管理功能。

```
/miniapp
```

## 文件上传

直接向 bot 发送任何文件（文档、照片、视频、音频）即可上传。文件将以原始文件名作为键名存储到默认存储桶中。

对于以压缩图片形式（非文档模式）发送的照片，bot 会存储可用的最高分辨率版本。

## 回调操作

部分命令会触发内联按钮进行交互式操作：

- **删除确认** -- `/delete` 后出现 "确认删除" / "取消" 按钮
- **撤销确认** -- `/revoke` 后出现 "确认撤销" / "取消" 按钮
- **分页** -- 长列表的 "下一页" / "上一页"

回调数据的有效期为 5-10 分钟。如果按钮无响应，请重新执行该命令。
