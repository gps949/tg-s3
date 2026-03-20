# Reference de configuration

[English](configuration.md) | [中文](configuration.zh.md) | [日本語](configuration.ja.md) | [Français](configuration.fr.md)

## Variables d'environnement

Toute la configuration se fait via des variables d'environnement. Pour le déploiement Docker, définissez-les dans `.env`. Pour le déploiement manuel, elles sont lues depuis `.env` par `deploy.sh` et envoyées en tant que secrets Cloudflare.

### Requises

| Variable | Description | Exemple |
|----------|-------------|---------|
| `TG_BOT_TOKEN` | Token API du bot Telegram, obtenu via @BotFather | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `DEFAULT_CHAT_ID` | Chat ID du groupe/supergroupe Telegram | `-1001234567890` |
| `S3_ACCESS_KEY_ID` | Clé d'accès S3 pour l'authentification client | `myaccesskey` |
| `S3_SECRET_ACCESS_KEY` | Clé secrète S3 pour l'authentification client | `mysecretkey123` |
| `BEARER_TOKEN` | Secret partagé pour la vérification du webhook Bot et l'authentification interne | `random-string-here` |

### Cloudflare (deploiement Docker)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `CLOUDFLARE_API_TOKEN` | Token API CF (requis pour Docker, optionnel pour le manuel) | `cf-api-token...` |
| `CF_ACCOUNT_ID` | Identifiant du compte CF (détecté automatiquement si non défini) | `abc123def456` |
| `CF_CUSTOM_DOMAIN` | Domaine personnalisé pour le Worker | `s3.example.com` |

### VPS / Processeur (optionnel)

| Variable | Description | Valeur par défaut |
|----------|-------------|-------------------|
| `VPS_SSH` | Chaîne de connexion SSH pour le déploiement VPS | -- |
| `VPS_DEPLOY_DIR` | Répertoire de déploiement sur le VPS | `/opt/tg-s3` |
| `VPS_PORT` | Port du service processeur | `3000` |
| `VPS_URL` | URL publique du processeur VPS | -- |
| `VPS_SECRET` | Secret d'authentification entre le Worker et le processeur | -- |
| `TG_LOCAL_API` | Point de terminaison de l'API Telegram Local Bot | `https://api.telegram.org` |

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

### Taches de maintenance cron

Le gestionnaire planifié s'exécute toutes les 6 heures et effectue :

1. Nettoyage des tokens de partage expirés
2. Nettoyage des tokens de partage orphelins (objet supprimé mais partage encore présent)
3. Nettoyage des uploads multipart obsolètes (plus de 24 heures)
4. Nettoyage des chunks orphelins
5. Nettoyage des enregistrements de tentatives de mot de passe expirés
6. Vérification de cohérence (échantillon de 50 objets, vérification de l'accès aux fichiers Telegram)
7. Nettoyage du cache R2 (éviction des objets supprimés de D1)

## Notes de securite

- Les **identifiants S3** sont utilisés pour la vérification de signature AWS SigV4. Choisissez des valeurs aléatoires robustes.
- Le **BEARER_TOKEN** authentifie les appels webhook Telegram et la génération d'URL présignées. Gardez-le secret.
- Le **VPS_SECRET** authentifie la communication entre le Worker et le processeur. Utilisez une valeur aléatoire distincte.
- Le **CLOUDFLARE_API_TOKEN** dispose d'un accès en écriture à votre compte CF. Ne le commitez jamais dans git.
- Le fichier `.env` est inclus dans `.gitignore` et `.dockerignore` par défaut.

## Limites de requetes

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
| Envoi de fichier | 50 Mo (API Bot) / 2 Go (API Bot locale) |
