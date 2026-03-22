# TG-S3

**Stockage compatible S3, propulsé par Telegram, sur Cloudflare Workers**

[English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Français](README.fr.md)

---

TG-S3 transforme Telegram en backend de stockage objet compatible S3. Les fichiers sont stockés sous forme de messages Telegram, les métadonnées sont dans Cloudflare D1, et le tout fonctionne sur Cloudflare Workers sans dépendance runtime.

## Fonctionnalités

- **API compatible S3** -- 27 opérations dont l'upload multipart, les URL présignées et les requêtes conditionnelles
- **Stockage gratuit illimité** -- Telegram fournit la couche de stockage gratuitement
- **Cache à trois niveaux** -- CF CDN (L1) -> R2 (L2) -> Telegram (L3) pour des lectures rapides
- **Bot Telegram** -- Gérez fichiers, buckets et partages directement depuis Telegram
- **Mini App** -- Interface web complète dans Telegram avec navigateur de fichiers, uploads et gestion des partages
- **Partage de fichiers** -- Liens de partage avec protection par mot de passe, expiration, limite de téléchargements et aperçu en ligne
- **Chiffrement côté serveur** -- SSE-C (clés fournies par le client) et SSE-S3 (clés gérées par le serveur) avec AES-256-GCM
- **Support gros fichiers** -- Fichiers jusqu'à 2 Go via proxy VPS optionnel avec Local Bot API
- **Traitement média** -- Conversion d'images (HEIC/WebP), transcodage vidéo, gestion Live Photo via VPS
- **Authentification multi-identifiants** -- Gestion des identifiants D1 avec permissions par bucket et par opération
- **Cloudflare Tunnel** -- Connectivité VPS sécurisée sans exposer de ports publics
- **Multilingue** -- Mini App en anglais, chinois, japonais et français
- **Zéro coût initial** -- Les fonctionnalités principales fonctionnent entièrement sur le plan gratuit Cloudflare

## Architecture

```
Client S3 ──────┐
                │
Bot Telegram ───┤
                ├──▶ Cloudflare Worker ──▶ D1 (métadonnées)
Mini App ───────┤         │                R2 (cache)
                │         │
Liens partage ──┘         ▼
                     API Telegram ◀──▶ Proxy VPS (optionnel, >20 Mo)
```

**Composants :**

| Composant | Rôle | Coût |
|-----------|------|------|
| CF Worker | Passerelle API S3, webhook Bot, hôte Mini App | Plan gratuit |
| CF D1 | Stockage métadonnées (objets, buckets, partages) | Plan gratuit |
| CF R2 | Cache persistant, fichiers <=20 Mo | Plan gratuit (10 Go) |
| Telegram | Stockage persistant de fichiers (illimité) | Gratuit |
| VPS + Processor | Gros fichiers (>20 Mo), traitement média | ~4 $/mois (optionnel) |

## Démarrage rapide

### Prérequis

- Node.js 22+
- Un [Bot Telegram](https://t.me/BotFather) avec son token
- Un groupe/supergroupe Telegram (obtenir le Chat ID via [@userinfobot](https://t.me/userinfobot))
- Un [compte Cloudflare](https://dash.cloudflare.com)

### Option 1 : Docker (recommandé)

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
cp .env.example .env
# Éditez .env : seuls TG_BOT_TOKEN, DEFAULT_CHAT_ID et CLOUDFLARE_API_TOKEN sont nécessaires
./deploy.sh
```

Le script détecte automatiquement l'environnement et gère tout : construction des images, déploiement du Worker, configuration du tunnel (si `CF_CUSTOM_DOMAIN` est défini) et démarrage des services. Les identifiants S3 peuvent être créés dans le Mini App Telegram (onglet Keys) selon les besoins.

### Option 2 : Déploiement manuel (sans Docker)

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
npm install
cp .env.example .env
# Éditez .env : seuls TG_BOT_TOKEN et DEFAULT_CHAT_ID sont nécessaires

# Déployer (détection automatique de l'environnement, génération de tous les secrets)
./deploy.sh

# (Optionnel) Déploiement VPS SSH legacy
./deploy.sh --vps
```

### Vérification

Configurez n'importe quel client S3 vers l'URL de votre Worker :

```bash
# Avec AWS CLI
aws configure set aws_access_key_id YOUR_KEY
aws configure set aws_secret_access_key YOUR_SECRET
aws --endpoint-url https://your-worker.workers.dev s3 ls

# Avec rclone
rclone config create tgs3 s3 \
  provider=Other \
  access_key_id=YOUR_KEY \
  secret_access_key=YOUR_SECRET \
  endpoint=https://your-worker.workers.dev \
  acl=private
rclone ls tgs3:default
```

## Compatibilité S3

27 opérations supportées couvrant le CRUD objets, l'upload multipart, la gestion des buckets et l'authentification.

| Catégorie | Opérations |
|-----------|-----------|
| Objets | GetObject, PutObject, HeadObject, DeleteObject, DeleteObjects, CopyObject |
| Tags | GetObjectTagging, PutObjectTagging, DeleteObjectTagging |
| Listing | ListObjectsV2, ListObjects (v1) |
| Multipart | CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListParts, ListMultipartUploads |
| Buckets | ListBuckets, CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation, GetBucketVersioning |
| Lifecycle | GetBucketLifecycleConfiguration, PutBucketLifecycleConfiguration, DeleteBucketLifecycleConfiguration |
| Auth | AWS SigV4 (multi-identifiants), URL présignées, Bearer token, Telegram initData |

**Non supporté (par conception) :** versioning, ACL, réplication inter-régions. Voir [docs/S3-COMPAT.md](docs/S3-COMPAT.md) pour les détails.

## Commandes du Bot Telegram

| Commande | Description |
|----------|-------------|
| `/start` | Message de bienvenue |
| `/help` | Référence des commandes |
| `/buckets` | Lister tous les buckets |
| `/ls <bucket> [prefix]` | Lister les objets |
| `/info <bucket> <key>` | Détails d'un objet |
| `/search <bucket> <query>` | Rechercher des objets |
| `/share <bucket> <key>` | Créer un lien de partage |
| `/shares` | Lister les partages actifs |
| `/revoke <token>` | Révoquer un partage |
| `/delete <bucket> <key>` | Supprimer un objet (avec confirmation) |
| `/stats` | Statistiques de stockage |
| `/setbucket <name>` | Définir le bucket par défaut |
| `/miniapp` | Ouvrir la Mini App |

Envoyez un fichier au Bot pour l'uploader dans le bucket par défaut.

## Documentation

- [Guide de déploiement](docs/deployment.fr.md)
- [Référence de configuration](docs/configuration.fr.md)
- [Commandes du Bot](docs/bot-commands.fr.md)
- [Compatibilité S3](docs/S3-COMPAT.md)
- [Conception de l'architecture](docs/design/00-overview.md)

## Stack technique

- **Runtime :** Cloudflare Workers (zéro dépendance runtime)
- **Base de données :** Cloudflare D1 (SQLite)
- **Cache :** Cloudflare R2 + CF Cache API
- **Auth :** AWS SigV4, URL présignées, Bearer tokens
- **Langage :** TypeScript (mode strict)
- **Traitement média :** Sharp + FFmpeg (VPS uniquement)
- **Build :** wrangler v3

## Licence

MIT
