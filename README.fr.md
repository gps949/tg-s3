# TG-S3

**Stockage compatible S3, propulse par Telegram, sur Cloudflare Workers**

[English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Français](README.fr.md)

---

TG-S3 transforme Telegram en backend de stockage objet compatible S3. Les fichiers sont stockes sous forme de messages Telegram, les metadonnees sont dans Cloudflare D1, et le tout fonctionne sur Cloudflare Workers sans dependance runtime.

## Fonctionnalites

- **API compatible S3** -- 22 operations dont l'upload multipart, les URL presignees et les requetes conditionnelles
- **Stockage gratuit illimite** -- Telegram fournit la couche de stockage gratuitement
- **Cache a trois niveaux** -- CF CDN (L1) -> R2 (L2) -> Telegram (L3) pour des lectures rapides
- **Bot Telegram** -- Gerez fichiers, buckets et partages directement depuis Telegram
- **Mini App** -- Interface web complete dans Telegram avec navigateur de fichiers, uploads et gestion des partages
- **Partage de fichiers** -- Liens de partage avec protection par mot de passe, expiration, limite de telechargements et apercu en ligne
- **Support gros fichiers** -- Fichiers jusqu'a 2 Go via proxy VPS optionnel avec Local Bot API
- **Traitement media** -- Conversion d'images (HEIC/WebP), transcodage video, gestion Live Photo via VPS
- **Multilingue** -- Mini App en anglais, chinois, japonais et francais
- **Zero cout initial** -- Les fonctionnalites principales fonctionnent entierement sur le plan gratuit Cloudflare

## Architecture

```
Client S3 ──────┐
                │
Bot Telegram ───┤
                ├──▶ Cloudflare Worker ──▶ D1 (metadonnees)
Mini App ───────┤         │                R2 (cache)
                │         │
Liens partage ──┘         ▼
                     API Telegram ◀──▶ Proxy VPS (optionnel, >20 Mo)
```

**Composants :**

| Composant | Role | Cout |
|-----------|------|------|
| CF Worker | Passerelle API S3, webhook Bot, hote Mini App | Plan gratuit |
| CF D1 | Stockage metadonnees (objets, buckets, partages) | Plan gratuit |
| CF R2 | Cache persistant, fichiers <=25 Mo | Plan gratuit (10 Go) |
| Telegram | Stockage persistant de fichiers (illimite) | Gratuit |
| VPS + Processor | Gros fichiers (>20 Mo), traitement media | ~4 $/mois (optionnel) |

## Demarrage rapide

### Prerequis

- Node.js 22+
- Un [Bot Telegram](https://t.me/BotFather) avec son token
- Un groupe/supergroupe Telegram (obtenir le Chat ID via [@userinfobot](https://t.me/userinfobot))
- Un [compte Cloudflare](https://dash.cloudflare.com)

### Option 1 : Docker (recommande)

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
cp .env.example .env
# Editez .env avec vos identifiants
docker compose up -d
```

Le service `deploy` pousse le Worker sur Cloudflare puis s'arrete. Le service `processor` reste actif pour le support des gros fichiers et le traitement media.

### Option 2 : Deploiement manuel

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
npm install
cp .env.example .env
# Editez .env avec vos identifiants

# Deployer le Cloudflare Worker
./deploy.sh --cf-only

# (Optionnel) Deployer le processeur VPS
./deploy.sh --vps-only
```

### Verification

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

## Compatibilite S3

22 operations supportees couvrant le CRUD objets, l'upload multipart, la gestion des buckets et l'authentification.

| Categorie | Operations |
|-----------|-----------|
| Objets | GetObject, PutObject, HeadObject, DeleteObject, DeleteObjects, CopyObject |
| Listing | ListObjectsV2, ListObjects (v1) |
| Multipart | CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListParts, ListMultipartUploads |
| Buckets | ListBuckets, CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation, GetBucketVersioning |
| Auth | AWS SigV4, URL presignees, Bearer token |

**Non supporte (par conception) :** versioning, chiffrement cote serveur, politiques de cycle de vie, ACL, replication inter-regions. Voir [docs/S3-COMPAT.md](docs/S3-COMPAT.md) pour les details.

## Commandes du Bot Telegram

| Commande | Description |
|----------|-------------|
| `/start` | Message de bienvenue |
| `/help` | Reference des commandes |
| `/buckets` | Lister tous les buckets |
| `/ls [bucket] [prefix]` | Lister les objets |
| `/info <bucket> <key>` | Details d'un objet |
| `/search <query>` | Rechercher des objets |
| `/share <bucket> <key>` | Creer un lien de partage |
| `/shares` | Lister les partages actifs |
| `/revoke <token>` | Revoquer un partage |
| `/delete <bucket> <key>` | Supprimer un objet (avec confirmation) |
| `/stats` | Statistiques de stockage |
| `/setbucket <name>` | Definir le bucket par defaut |
| `/miniapp` | Ouvrir la Mini App |

Envoyez un fichier au Bot pour l'uploader dans le bucket par defaut.

## Documentation

- [Guide de deploiement](docs/deployment.fr.md)
- [Reference de configuration](docs/configuration.fr.md)
- [Commandes du Bot](docs/bot-commands.fr.md)
- [Compatibilite S3](docs/S3-COMPAT.md)
- [Conception de l'architecture](docs/design/00-overview.md)

## Stack technique

- **Runtime :** Cloudflare Workers (zero dependance runtime)
- **Base de donnees :** Cloudflare D1 (SQLite)
- **Cache :** Cloudflare R2 + CF Cache API
- **Auth :** AWS SigV4, URL presignees, Bearer tokens
- **Langage :** TypeScript (mode strict)
- **Traitement media :** Sharp + FFmpeg (VPS uniquement)
- **Build :** wrangler v3

## Licence

MIT
