# Guide de deploiement

[English](deployment.md) | [中文](deployment.zh.md) | [日本語](deployment.ja.md) | [Français](deployment.fr.md)

## Niveaux de deploiement

TG-S3 propose trois niveaux de deploiement :

| Niveau | Composants | Cout | Capacites |
|--------|-----------|------|-----------|
| Minimal | CF Worker + D1 + R2 | 0 $/mois | API S3, Bot, Mini App, fichiers jusqu'a 20 Mo |
| Standard | Minimal + VPS | ~4 $/mois | + fichiers jusqu'a 2 Go, traitement multimedia |
| Enhanced | Standard + CF plan payant | ~9 $/mois | + limites de requetes plus elevees, plus de requetes D1 |

## Prerequis

1. **Bot Telegram** -- Creez-en un via [@BotFather](https://t.me/BotFather) et conservez le token
2. **Groupe Telegram** -- Creez un groupe/supergroupe, ajoutez votre bot en tant qu'administrateur, recuperez le chat ID
3. **Compte Cloudflare** -- Inscrivez-vous sur [dash.cloudflare.com](https://dash.cloudflare.com)
4. **Node.js 22+** -- Requis pour le CLI wrangler (deploiement manuel uniquement)

### Obtenir le Chat ID

Ajoutez [@userinfobot](https://t.me/userinfobot) a votre groupe temporairement. Il repondra avec le chat ID (un nombre negatif comme `-1001234567890`). Retirez-le ensuite.

### Creer un token API Cloudflare

Pour le deploiement Docker, creez un token sur [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) avec les permissions suivantes :
- Account / Workers Scripts: Edit
- Account / D1: Edit
- Account / R2: Edit
- Account / Account Settings: Read
- Account / Cloudflare Tunnel: Edit *(uniquement si vous utilisez le tunnel)*
- Zone / DNS: Edit *(uniquement si vous utilisez le tunnel avec un domaine personnalise)*

## Methode 1 : Deploiement Docker (recommande)

Ideal pour le deploiement sur VPS. Une seule commande gere tout.

```bash
# Cloner et configurer
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
cp .env.example .env
```

Modifiez `.env` avec les valeurs requises (seulement 2 obligatoires) :

```bash
# Requis
TG_BOT_TOKEN=123456:ABC-DEF...
DEFAULT_CHAT_ID=-1001234567890

# Deploiement Docker
CLOUDFLARE_API_TOKEN=your-cf-api-token

# Optionnel : domaine personnalise (active aussi la creation automatique du tunnel)
CF_CUSTOM_DOMAIN=s3.example.com
```

Les autres identifiants (cles S3, BEARER_TOKEN, VPS_SECRET) sont **generes automatiquement** lors du deploiement.

Deployez :

```bash
docker compose up -d
```

Cela demarre deux services :
- **deploy** -- Pousse le Worker vers Cloudflare, cree les identifiants D1, genere les secrets automatiquement (s'execute une fois, puis s'arrete)
- **processor** -- Gere les fichiers volumineux et le traitement multimedia (reste actif en permanence)

Les identifiants S3 sont affiches dans les logs de deploiement. Conservez-les pour la configuration client :

```bash
docker compose logs deploy
```

### Cloudflare Tunnel (recommande pour VPS)

Cloudflare Tunnel cree une connexion securisee entre le processeur et les CF Workers sans exposer de ports publics.

**Configuration automatique** (necessite `CF_CUSTOM_DOMAIN` dans `.env`) :

`deploy.sh` cree automatiquement un tunnel et configure le DNS. Le nom d'hote du tunnel sera `vps.<votre-domaine>`. Demarrez avec :

```bash
docker compose --profile tunnel up -d
```

**Configuration manuelle** (sans domaine personnalise) :

1. Allez dans CF Dashboard > Zero Trust > Networks > Tunnels
2. Creez un tunnel nomme `tg-s3`
3. Ajoutez un nom d'hote public pointant vers `http://processor:3000`
4. Copiez le token du tunnel dans `.env` :

```bash
CF_TUNNEL_TOKEN=eyJhIjo...
```

5. Demarrez avec le profil tunnel :

```bash
docker compose --profile tunnel up -d
```

Le tunnel remplace `VPS_URL` -- le Worker atteint le processeur via le reseau Cloudflare au lieu d'une connexion directe.

### Mise a jour

```bash
git pull
docker compose up -d --build
```

## Methode 2 : Deploiement manuel

### Worker Cloudflare uniquement (niveau Minimal)

```bash
npm install
cp .env.example .env
# Modifiez .env (seuls TG_BOT_TOKEN et DEFAULT_CHAT_ID sont requis)

./deploy.sh --cf-only
```

Le script va :
1. Valider la configuration
2. Creer la base de donnees D1 et initialiser le schema
3. Creer le bucket R2 avec la politique de cycle de vie
4. Generer automatiquement BEARER_TOKEN et VPS_SECRET
5. Creer les identifiants S3 admin initiaux dans D1
6. Definir tous les secrets dans Cloudflare
7. Deployer le Worker
8. Enregistrer le webhook du bot Telegram

### Avec VPS (niveau Standard)

Assurez-vous que votre `.env` contient les parametres VPS :

```bash
VPS_SSH=user@your-vps-ip
VPS_DEPLOY_DIR=/opt/tg-s3
VPS_PORT=3000
VPS_URL=https://vps.example.com:3000
# VPS_SECRET est genere automatiquement s'il n'est pas defini
```

Puis deployez le tout :

```bash
./deploy.sh --all
```

Ou deployez le VPS separement :

```bash
./deploy.sh --vps-only
```

Le deploiement VPS va :
1. Verifier la connectivite SSH
2. Installer Docker si necessaire
3. Transferer les fichiers du processeur via rsync
4. Construire et demarrer le conteneur du processeur

## Apres le deploiement

### Identifiants S3

Les identifiants S3 sont affiches une seule fois lors du deploiement. Vous pouvez ensuite gerer les identifiants (creer, revoquer, definir des permissions par bucket) dans l'onglet **Keys** de la Mini App.

### Verifier l'acces S3

```bash
# AWS CLI (utilisez les identifiants de la sortie du deploiement)
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

### Verifier le bot

Envoyez `/start` a votre bot dans Telegram. Il devrait repondre avec un message de bienvenue.

### Verifier la Mini App

Envoyez `/miniapp` au bot, ou accedez directement a `https://your-worker.workers.dev/miniapp`.

## Domaine personnalise

1. Ajoutez un enregistrement CNAME dans le DNS Cloudflare pointant vers votre Worker
2. Dans le tableau de bord Cloudflare, allez dans Workers & Pages > votre Worker > Settings > Triggers
3. Ajoutez le domaine personnalise
4. Definissez `CF_CUSTOM_DOMAIN` dans `.env` et redeployez

## Depannage

### Le Worker ne repond pas
- Consultez `npx wrangler tail` pour les logs en direct
- Verifiez que les secrets sont definis : `npx wrangler secret list`

### Le bot ne recoit pas les messages
- Verifiez le webhook : `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Reenregistrez : `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.workers.dev/bot/webhook&secret_token=<BEARER_TOKEN>"`

### Erreurs D1
- Verifiez que la base de donnees existe : `npx wrangler d1 list`
- Reinitialisez le schema : `npm run db:init:remote`

### Le processeur VPS n'est pas joignable
- Verifiez le conteneur : `docker compose logs processor`
- Verifiez que le port est ouvert : `curl http://localhost:3000/health`
- Envisagez d'utiliser Cloudflare Tunnel au lieu de l'exposition directe du port
