# Telegram Bot Commands

[English](bot-commands.md) | [中文](bot-commands.zh.md) | [日本語](bot-commands.ja.md) | [Français](bot-commands.fr.md)

## Overview

The TG-S3 bot provides a Telegram interface for managing your S3 storage. All commands work in the designated storage group or in direct messages with the bot.

## Commands

### /start

Displays a welcome message with a brief introduction and quick start guide.

### /help

Shows the full command reference with syntax and examples.

### /buckets

Lists all buckets with their object count and total size.

```
/buckets
```

Output example:
```
Buckets (3):
  default - 42 objects, 156.3 MB
  photos  - 128 objects, 1.2 GB
  backup  - 7 objects, 89.5 MB
```

### /ls

Lists objects in a bucket with optional prefix filtering.

```
/ls <bucket> [prefix]
```

- With bucket: lists objects in that bucket
- With prefix: filters by key prefix (acts like a directory listing)

Examples:
```
/ls photos
/ls photos 2024/january/
```

### /info

Shows detailed information about a specific object.

```
/info <bucket> <key>
```

Output includes: size, content type, ETag, upload date, and bucket name.

### /search

Searches objects in a bucket by key pattern.

```
/search <bucket> <query>
```

The query matches against object keys using substring search within the specified bucket.

### /share

Creates a share link for a file with optional restrictions.

```
/share <bucket> <key>
```

Optional parameters can be appended after the key:

```
/share <bucket> <key> [expiresIn_seconds] [password] [maxDownloads]
```

- **expiresIn**: expiry duration in seconds (default: no expiry)
- **password**: password protection (default: none)
- **maxDownloads**: download limit (default: unlimited)

The generated link format: `https://your-worker.workers.dev/share/<token>`

Share links support:
- `/share/<token>` -- Preview page with metadata
- `/share/<token>/download` -- Direct download
- `/share/<token>/inline` -- Inline display (images, videos)
- `/share/<token>/live-video` -- Live Photo video component (Apple Live Photos)

### /shares

Lists all active (non-expired, non-exhausted) share tokens.

```
/shares [bucket]
```

- Without bucket: lists shares for all buckets
- With bucket: lists shares for the specified bucket only

Shows token, linked file, creation date, expiry, download count, and password status.

### /revoke

Revokes an active share token, making the link immediately invalid.

```
/revoke <token>
```

### /delete

Deletes an object from storage. Requires confirmation via inline button.

```
/delete <bucket> <key>
```

Deletion is a full cascade: removes the Telegram message, all derivative objects (thumbnails, transcoded versions), associated share tokens, and cache entries.

### /stats

Shows storage statistics across all buckets.

```
/stats
```

Output includes: total objects, total size, and bucket count.

### /setbucket

Sets the default bucket for file uploads (sending files directly to the bot).

```
/setbucket <name>
```

### /miniapp

Opens the Telegram Mini App inline interface for full-featured file management with a graphical UI.

```
/miniapp
```

## File Upload

Send any file (document, photo, video, audio) directly to the bot to upload it. The file will be stored in the default bucket with the original filename as the key.

For photos sent as compressed images (not documents), the bot stores the highest-resolution version available.

## Callback Actions

Some commands trigger inline buttons for interactive workflows:

- **Delete confirmation** -- "Yes, delete" / "Cancel" buttons after `/delete`
- **Revoke confirmation** -- "Confirm revoke" / "Cancel" buttons after `/revoke`
- **Pagination** -- "Next page" / "Previous page" for long listings

Callback data has a 5-10 minute TTL. If buttons stop responding, re-issue the command.
