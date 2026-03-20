# Reference de configuration

[English](configuration.md) | [中文](configuration.zh.md) | [日本語](configuration.ja.md) | [Français](configuration.fr.md)

## Variables d'environnement

Toute la configuration se fait via des variables d'environnement. Pour le deploiement Docker, definissez-les dans `.env`. Pour le deploiement manuel, elles sont lues depuis `.env` par `deploy.sh` et envoyees en tant que secrets Cloudflare.

### Requises

| Variable | Description | Exemple |
|----------|-------------|---------|
| `TG_BOT_TOKEN` | Token API du bot Telegram, obtenu via @BotFather | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `DEFAULT_CHAT_ID` | Chat ID du groupe/supergroupe Telegram | `-1001234567890` |

### Generees automatiquement (pas besoin de les definir)

| Variable | Description | Generee par |
|----------|-------------|-------------|
| `BEARER_TOKEN` | Secret partage pour la verification du webhook Bot et l'authentification interne | `deploy.sh` (chaine aleatoire de 48 caracteres) |
| `VPS_SECRET` | Secret d'authentification entre le Worker et le processeur | `deploy.sh` (chaine aleatoire de 48 caracteres) |
| Identifiants S3 | Cle d'acces + cle secrete pour l'authentification API S3 | `deploy.sh` (crees dans la table D1 `credentials`) |

Les identifiants S3 sont affiches une seule fois lors du deploiement. Gerez-les ensuite dans l'onglet **Keys** de la Mini App (creer, revoquer, definir des permissions par bucket).

### Identifiants S3 ancienne version (optionnel)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `S3_ACCESS_KEY_ID` | Ancienne cle d'acces S3 unique (fallback si D1 n'a pas d'identifiants) | `myaccesskey` |
| `S3_SECRET_ACCESS_KEY` | Ancienne cle secrete S3 unique | `mysecretkey123` |

Les nouveaux deploiements utilisent le systeme multi-identifiants D1. Ces variables ne sont necessaires que pour la compatibilite avec les deploiements existants.

### Cloudflare (deploiement Docker)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `CLOUDFLARE_API_TOKEN` | Token API CF (requis pour Docker, optionnel pour le manuel) | `cf-api-token...` |
| `CF_ACCOUNT_ID` | Identifiant du compte CF (detecte automatiquement si non defini) | `abc123def456` |
| `CF_CUSTOM_DOMAIN` | Domaine personnalise pour le Worker (active aussi la creation automatique du tunnel) | `s3.example.com` |
| `CF_TUNNEL_TOKEN` | Token du connecteur Cloudflare Tunnel (cree automatiquement avec CF_CUSTOM_DOMAIN, ou a definir manuellement) | `eyJhIjo...` |

Permissions du token API : Workers Scripts:Edit, D1:Edit, R2:Edit, Account Settings:Read. Ajoutez Cloudflare Tunnel:Edit et DNS:Edit pour la creation automatique du tunnel.

### VPS / Processeur (optionnel)

| Variable | Description | Valeur par defaut |
|----------|-------------|-------------------|
| `VPS_SSH` | Chaine de connexion SSH pour le deploiement VPS | -- |
| `VPS_DEPLOY_DIR` | Repertoire de deploiement sur le VPS | `/opt/tg-s3` |
| `VPS_PORT` | Port du service processeur | `3000` |
| `VPS_URL` | URL publique du processeur VPS (definie automatiquement avec le tunnel) | -- |
| `VPS_SECRET` | Secret d'authentification entre le Worker et le processeur (genere automatiquement) | -- |
| `TG_LOCAL_API` | Point de terminaison de l'API Telegram Local Bot | `https://api.telegram.org` |

### Runtime du Worker

Ces valeurs sont definies dans `wrangler.toml` en tant que vars ou bindings :

| Variable | Description | Valeur par defaut |
|----------|-------------|-------------------|
| `S3_REGION` | Region AWS declaree | `us-east-1` |
| `WORKER_URL` | URL publique du Worker (definie automatiquement par deploy.sh) | -- |

### Bindings D1 et R2

Configures dans `wrangler.toml` :

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

Le gestionnaire planifie s'execute toutes les 6 heures et effectue :

1. Nettoyage des tokens de partage expires
2. Nettoyage des tokens de partage orphelins (objet supprime mais partage encore present)
3. Nettoyage des uploads multipart obsoletes (plus de 24 heures)
4. Nettoyage des chunks orphelins
5. Nettoyage des enregistrements de tentatives de mot de passe expires
6. Verification de coherence (echantillon de 50 objets, verification de l'acces aux fichiers Telegram)
7. Nettoyage du cache R2 (eviction des objets supprimes de D1)

## Notes de securite

- Les **identifiants S3** sont stockes dans D1 et utilises pour la verification de signature AWS SigV4. Des valeurs aleatoires robustes sont generees automatiquement. Gerez-les dans l'onglet Keys de la Mini App.
- Le **BEARER_TOKEN** authentifie les appels webhook Telegram et la validation initData de la Mini App. Genere automatiquement s'il n'est pas defini.
- Le **VPS_SECRET** authentifie la communication entre le Worker et le processeur. Genere automatiquement s'il n'est pas defini.
- Le **CLOUDFLARE_API_TOKEN** dispose d'un acces en ecriture a votre compte CF. Ne le commitez jamais dans git.
- Le fichier `.env` est inclus dans `.gitignore` et `.dockerignore` par defaut.

## Limites de requetes

### Offre gratuite Cloudflare

| Ressource | Limite |
|-----------|--------|
| Requetes Worker | 100 000/jour |
| Lectures D1 | 5 000 000/jour |
| Ecritures D1 | 100 000/jour |
| Requetes D1 par invocation | 50 |
| Operations R2 Classe A (ecriture) | 1 000 000/mois |
| Operations R2 Classe B (lecture) | 10 000 000/mois |
| Stockage R2 | 10 Go |

### API Bot Telegram

| Ressource | Limite |
|-----------|--------|
| Messages par canal | ~20/minute |
| Debit global de messages | ~30/seconde |
| Telechargement de fichier | 20 Mo (API Bot) / 2 Go (API Bot locale) |
| Envoi de fichier | 50 Mo (API Bot) / 2 Go (API Bot locale) |
