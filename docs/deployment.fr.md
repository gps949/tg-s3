# Guide de deploiement

[English](deployment.md) | [中文](deployment.zh.md) | [日本語](deployment.ja.md) | [Français](deployment.fr.md)

## Niveaux de deploiement

TG-S3 propose trois niveaux de déploiement :

| Niveau | Composants | Coût | Capacités |
|--------|-----------|------|-----------|
| Minimal | CF Worker + D1 + R2 | 0 $/mois | API S3, Bot, Mini App, fichiers jusqu'à 20 Mo |
| Standard | Minimal + VPS | ~4 $/mois | + fichiers jusqu'à 2 Go, traitement multimédia |
| Enhanced | Standard + CF plan payant | ~9 $/mois | + limites de requêtes plus élevées, plus de requêtes D1 |

## Prerequis

1. **Bot Telegram** -- Créez-en un via [@BotFather](https://t.me/BotFather) et conservez le token
2. **Groupe Telegram** -- Créez un groupe/supergroupe, ajoutez votre bot en tant qu'administrateur, récupérez le chat ID
3. **Compte Cloudflare** -- Inscrivez-vous sur [dash.cloudflare.com](https://dash.cloudflare.com)
4. **Node.js 22+** -- Requis pour le CLI wrangler (déploiement manuel uniquement)

### Obtenir le Chat ID

Ajoutez [@userinfobot](https://t.me/userinfobot) à votre groupe temporairement. Il répondra avec le chat ID (un nombre négatif comme `-1001234567890`). Retirez-le ensuite.

### Creer un token API Cloudflare

Pour le déploiement Docker, créez un token sur [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) avec les permissions suivantes :
- Account / Workers Scripts: Edit
- Account / D1: Edit
- Account / R2: Edit
- Account / Account Settings: Read

## Methode 1 : Deploiement Docker (recommande)

Idéal pour le déploiement sur VPS. Une seule commande gère tout.

```bash
# Cloner et configurer
git clone https://github.com/pocketclouds/tg-s3.git
cd tg-s3
cp .env.example .env
```

Modifiez `.env` avec les valeurs requises :

```bash
# Requis
TG_BOT_TOKEN=123456:ABC-DEF...
DEFAULT_CHAT_ID=-1001234567890
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
BEARER_TOKEN=a-random-secret-string
CLOUDFLARE_API_TOKEN=your-cf-api-token

# Optionnel : domaine personnalisé
CF_CUSTOM_DOMAIN=s3.example.com
```

Déployez :

```bash
docker compose up -d
```

Cela démarre deux services :
- **deploy** -- Pousse le Worker vers Cloudflare (s'exécute une fois, puis s'arrête)
- **processor** -- Gère les fichiers volumineux et le traitement multimédia (reste actif en permanence)

Consultez les logs de déploiement :

```bash
docker compose logs deploy
```

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
# Modifiez .env

./deploy.sh --cf-only
```

Le script va :
1. Valider la configuration
2. Créer la base de données D1 et initialiser le schéma
3. Créer le bucket R2 avec la politique de cycle de vie
4. Définir tous les secrets dans Cloudflare
5. Déployer le Worker
6. Enregistrer le webhook du bot Telegram

### Avec VPS (niveau Standard)

Assurez-vous que votre `.env` contient les paramètres VPS :

```bash
VPS_SSH=user@your-vps-ip
VPS_DEPLOY_DIR=/opt/tg-s3
VPS_PORT=3000
VPS_URL=https://vps.example.com:3000
VPS_SECRET=a-random-vps-secret
```

Puis déployez le tout :

```bash
./deploy.sh --all
```

Ou déployez le VPS séparément :

```bash
./deploy.sh --vps-only
```

Le déploiement VPS va :
1. Vérifier la connectivité SSH
2. Installer Docker si nécessaire
3. Transférer les fichiers du processeur via rsync
4. Construire et démarrer le conteneur du processeur

## Apres le deploiement

### Verifier l'acces S3

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

### Verifier le bot

Envoyez `/start` à votre bot dans Telegram. Il devrait répondre avec un message de bienvenue.

### Verifier la Mini App

Envoyez `/miniapp` au bot, ou accédez directement à `https://your-worker.workers.dev/miniapp`.

## Domaine personnalise

1. Ajoutez un enregistrement CNAME dans le DNS Cloudflare pointant vers votre Worker
2. Dans le tableau de bord Cloudflare, allez dans Workers & Pages > votre Worker > Settings > Triggers
3. Ajoutez le domaine personnalisé
4. Définissez `CF_CUSTOM_DOMAIN` dans `.env` et redéployez

## Depannage

### Le Worker ne repond pas
- Consultez `npx wrangler tail` pour les logs en direct
- Vérifiez que les secrets sont définis : `npx wrangler secret list`

### Le bot ne recoit pas les messages
- Vérifiez le webhook : `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Réenregistrez : `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.workers.dev/bot/webhook&secret_token=<BEARER_TOKEN>"`

### Erreurs D1
- Vérifiez que la base de données existe : `npx wrangler d1 list`
- Réinitialisez le schéma : `npm run db:init:remote`

### Le processeur VPS n'est pas joignable
- Vérifiez le conteneur : `docker compose logs processor`
- Vérifiez que le port est ouvert : `curl http://localhost:3000/health`
- Assurez-vous que VPS_URL est accessible depuis les Workers Cloudflare
