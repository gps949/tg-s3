# Référence de configuration

[English](configuration.md) | [中文](configuration.zh.md) | [日本語](configuration.ja.md) | [Français](configuration.fr.md)

## Variables d'environnement

Toute la configuration se fait via des variables d'environnement. Pour le déploiement Docker, définissez-les dans `.env`. Pour le déploiement manuel, elles sont lues depuis `.env` par `deploy.sh` et envoyées en tant que secrets Cloudflare.

### Requises

| Variable | Description | Exemple |
|----------|-------------|---------|
| `TG_BOT_TOKEN` | Token API du bot Telegram, obtenu via @BotFather | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `DEFAULT_CHAT_ID` | Chat ID du groupe/supergroupe Telegram | `-1001234567890` |

### Générées automatiquement (pas besoin de les définir)

| Variable | Description | Générée par |
|----------|-------------|-------------|
| `VPS_SECRET` | Secret d'authentification entre le Worker et le processeur | `deploy.sh` (chaîne aléatoire de 48 caractères) |
| `SSE_MASTER_KEY` | Clé Base64 pour le chiffrement SSE-S3 côté serveur. Généré par deploy.sh. | `deploy.sh` |
| Identifiants S3 | Clé d'accès + clé secrète pour l'authentification API S3 | `deploy.sh` (créés dans la table D1 `credentials`) |
| Secret webhook | Secret de vérification du webhook Telegram | Dérivé de `TG_BOT_TOKEN` via HMAC-SHA256 |

Les identifiants S3 sont affichés une seule fois lors du déploiement. Gérez-les ensuite dans l'onglet **Keys** de la Mini App (créer, révoquer, définir des permissions par bucket).

### Cloudflare (déploiement Docker)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `CLOUDFLARE_API_TOKEN` | Token API CF (requis pour Docker, optionnel pour le manuel) | `cf-api-token...` |
| `CF_ACCOUNT_ID` | Identifiant du compte CF (détecté automatiquement si non défini) | `abc123def456` |
| `CF_CUSTOM_DOMAIN` | Domaine personnalisé pour le Worker (active aussi la création automatique du tunnel) | `s3.example.com` |
| `CF_TUNNEL_TOKEN` | Token du connecteur Cloudflare Tunnel (créé automatiquement avec CF_CUSTOM_DOMAIN, ou à définir manuellement) | `eyJhIjo...` |

Permissions du token API : Workers Scripts:Edit, D1:Edit, R2:Edit, Account Settings:Read. Ajoutez Cloudflare Tunnel:Edit et DNS:Edit pour la création automatique du tunnel.

### VPS / Processeur (optionnel)

| Variable | Description | Valeur par défaut |
|----------|-------------|-------------------|
| `VPS_SSH` | Chaîne de connexion SSH pour le déploiement VPS | -- |
| `VPS_DEPLOY_DIR` | Répertoire de déploiement sur le VPS | `/opt/tg-s3` |
| `VPS_PORT` | Port du service processeur | `3000` |
| `VPS_URL` | URL publique du processeur VPS (définie automatiquement avec le tunnel) | -- |
| `VPS_SECRET` | Secret d'authentification entre le Worker et le processeur (généré automatiquement) | -- |
| `TELEGRAM_API_ID` | ID API Telegram pour l'API Bot locale (depuis https://my.telegram.org). Active le support de fichiers 2 Go. | -- |
| `TELEGRAM_API_HASH` | Hash API Telegram pour l'API Bot locale (depuis https://my.telegram.org) | -- |

### Runtime du Worker

Ces valeurs sont définies dans `wrangler.toml` en tant que vars ou bindings :

| Variable | Description | Valeur par défaut |
|----------|-------------|-------------------|
| `S3_REGION` | Région AWS déclarée | `us-east-1` |
| `WORKER_URL` | URL publique du Worker (définie automatiquement par deploy.sh) | -- |

### Bindings D1 et R2

Configurés dans `wrangler.toml` :

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

Sections principales de configuration :

```toml
name = "tg-s3"
main = "src/index.ts"
compatibility_date = "2026-03-15"

[vars]
S3_REGION = "us-east-1"

[triggers]
crons = ["0 */6 * * *"]  # Maintenance toutes les 6 heures
```

### Tâches de maintenance cron

Le gestionnaire planifié s'exécute toutes les 6 heures et effectue :

1. Nettoyage des tokens de partage expirés
2. Nettoyage des tokens de partage orphelins (objet supprimé mais partage encore présent)
3. Nettoyage des uploads multipart obsolètes (plus de 24 heures)
4. Nettoyage des chunks orphelins
5. Nettoyage des enregistrements de tentatives de mot de passe expirés
6. Vérification de cohérence (échantillon de 50 objets, vérification de l'accès aux fichiers Telegram)
7. Nettoyage du cache R2 (éviction des objets supprimés de D1)

## Notes de sécurité

- Les **identifiants S3** sont stockés dans D1 et utilisés pour la vérification de signature AWS SigV4. Des valeurs aléatoires robustes sont générées automatiquement. Gérez-les dans l'onglet Keys de la Mini App.
- Le **secret webhook** est dérivé de manière déterministe de `TG_BOT_TOKEN` via HMAC-SHA256. Aucune variable d'environnement séparée n'est nécessaire.
- Le **VPS_SECRET** authentifie la communication entre le Worker et le processeur. Généré automatiquement s'il n'est pas défini.
- Le **CLOUDFLARE_API_TOKEN** dispose d'un accès en écriture à votre compte CF. Ne le commitez jamais dans git.
- Le fichier `.env` est inclus dans `.gitignore` et `.dockerignore` par défaut.

## Limites de requêtes

### Offre gratuite Cloudflare

| Ressource | Limite |
|-----------|--------|
| Requêtes Worker | 100 000/jour |
| Lectures D1 | 5 000 000/jour |
| Écritures D1 | 100 000/jour |
| Requêtes D1 par invocation | 50 |
| Opérations R2 Classe A (écriture) | 1 000 000/mois |
| Opérations R2 Classe B (lecture) | 10 000 000/mois |
| Stockage R2 | 10 Go |

### API Bot Telegram

| Ressource | Limite |
|-----------|--------|
| Messages par canal | ~20/minute |
| Débit global de messages | ~30/seconde |
| Téléchargement de fichier | 20 Mo (API Bot) / 2 Go (API Bot locale) |
| Envoi de fichier | 20 Mo (API Bot, aligné sur la limite de téléchargement) / 2 Go (API Bot locale) |
