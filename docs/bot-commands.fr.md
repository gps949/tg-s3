# Commandes du Bot Telegram

[English](bot-commands.md) | [中文](bot-commands.zh.md) | [日本語](bot-commands.ja.md) | [Français](bot-commands.fr.md)

## Aperçu

Le bot TG-S3 fournit une interface Telegram pour gérer votre stockage S3. Toutes les commandes fonctionnent dans le groupe de stockage désigné ou en messages directs avec le bot.

## Commandes

### /start

Affiche un message de bienvenue avec une brève introduction et un guide de démarrage rapide.

### /help

Affiche la référence complète des commandes avec la syntaxe et des exemples.

### /buckets

Liste tous les buckets avec leur nombre d'objets et leur taille totale.

```
/buckets
```

Exemple de sortie :
```
Buckets (3):
  default - 42 objects, 156.3 MB
  photos  - 128 objects, 1.2 GB
  backup  - 7 objects, 89.5 MB
```

### /ls

Liste les objets d'un bucket avec filtrage optionnel par préfixe.

```
/ls <bucket> [prefix]
```

- Avec un bucket : liste les objets de ce bucket
- Avec un préfixe : filtre par préfixe de clé (fonctionne comme un listing de répertoire)

Exemples :
```
/ls photos
/ls photos 2024/january/
```

### /info

Affiche les informations détaillées d'un objet spécifique.

```
/info <bucket> <key>
```

Les informations comprennent : taille, type de contenu, ETag, date d'envoi et nom du bucket.

### /search

Recherche des objets dans un bucket par motif de clé.

```
/search <bucket> <query>
```

La requête est comparée aux clés des objets par recherche de sous-chaîne dans le bucket spécifié.

### /share

Crée un lien de partage pour un fichier avec des restrictions optionnelles.

```
/share <bucket> <key>
```

Des paramètres optionnels peuvent être ajoutés après la clé :

```
/share <bucket> <key> [expiration_secondes] [mot_de_passe] [max_telechargements]
```

- **Expiration** : durée d'expiration en secondes (par défaut : sans expiration)
- **Mot de passe** : protection par mot de passe (par défaut : aucun)
- **Max téléchargements** : limite de téléchargement (par défaut : illimité)

Format du lien généré : `https://your-worker.workers.dev/share/<token>`

Les liens de partage supportent :
- `/share/<token>` -- Page d'aperçu avec métadonnées
- `/share/<token>/download` -- Téléchargement direct
- `/share/<token>/inline` -- Affichage en ligne (images, vidéos)

### /shares

Liste tous les tokens de partage actifs (non expirés, non épuisés).

```
/shares [bucket]
```

- Sans bucket : liste les partages de tous les buckets
- Avec bucket : liste uniquement les partages du bucket spécifié

Affiche le token, le fichier associé, la date de création, l'expiration, le nombre de téléchargements et le statut du mot de passe.

### /revoke

Révoque un token de partage actif, rendant le lien immédiatement invalide.

```
/revoke <token>
```

### /delete

Supprime un objet du stockage. Nécessite une confirmation via un bouton inline.

```
/delete <bucket> <key>
```

La suppression est en cascade complète : supprime le message Telegram, tous les objets dérivés (miniatures, versions transcodées), les tokens de partage associés et les entrées de cache.

### /stats

Affiche les statistiques de stockage pour l'ensemble des buckets.

```
/stats
```

Les informations comprennent : nombre total d'objets, taille totale et nombre de buckets.

### /setbucket

Définit le bucket par défaut pour l'envoi de fichiers directement au bot.

```
/setbucket <name>
```

### /miniapp

Ouvre l'interface Mini App Telegram en ligne pour une gestion complète des fichiers avec une interface graphique.

```
/miniapp
```

## Envoi de fichiers

Envoyez n'importe quel fichier (document, photo, vidéo, audio) directement au bot pour l'envoyer vers le stockage. Le fichier sera stocké dans le bucket par défaut avec le nom de fichier original comme clé.

Pour les photos envoyées en tant qu'images compressées (pas en tant que documents), le bot conserve la version en plus haute résolution disponible.

## Actions de callback

Certaines commandes déclenchent des boutons inline pour des flux interactifs :

- **Confirmation de suppression** -- Boutons "Oui, supprimer" / "Annuler" après `/delete`
- **Confirmation de révocation** -- Boutons "Confirmer" / "Annuler" après `/revoke`
- **Pagination** -- "Page suivante" / "Page précédente" pour les listings longs

Les données de callback ont un TTL de 5 à 10 minutes. Si les boutons ne répondent plus, relancez la commande.
