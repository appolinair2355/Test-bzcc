# Bot Baccara 1xbet — v2 (déployable sur Render.com)

## Corrections de cette version

- **Vérification fidèle de la main choisie** : les costumes sont lus sur **toute la main**
  (toutes les cartes) du **joueur**, pas sur une seule carte.
- **Compteur B sur les costumes de la main choisie** : +1 quand le costume apparaît,
  **0** quand il manque, et **il ne dépasse jamais le B configuré** : arrivé à B il
  repart à zéro, donc l'apparition suivante remet **1** (ex. B=3 → 1,2,3 puis 1…).
  Le B s'impose à **toutes** les prédictions : aucune prédiction n'est envoyée pendant
  qu'un costume est à son maximum.
- **Rattrapages** : on vérifie d'abord le **numéro prédit**, puis les rattrapages
  configurés ; si le costume n'est jamais venu → ❌. `/setmaxr <n>`
- **Aucun mot de passe** : le tableau de bord et les réglages sont directement
  accessibles (plus de `PANEL_PASSWORD`).
- **77 styles de prédiction** (`/setformat 1..77`, `/formats [page]`, `/apercu <n>`),
  repris de `tg-formats.js` + template personnalisé (`/settemplate`).
- **Aucun `\n` ni `'n` visible** : tous les messages passent par `formats.js`
  (nettoyage + choix automatique du `parse_mode` HTML pour les styles en gras).
- **Main du JOUEUR uniquement** : prédiction, compteur B et vérification lisent
  seulement `player_suits`.

## Déploiement Render

1. Crée un **Web Service** Node depuis ce dossier (`npm install` / `npm start`).
2. Optionnel : variables d'environnement `BOT_TOKEN`, `ADMIN_ID`.

## Commandes Telegram

| Commande | Effet |
|---|---|
| `/live` | jeu en cours : cartes, costumes, valeurs, parité, compteurs |
| `/setb <n>` | compteur B (apparitions consécutives max) |
| `/setmaxr <n>` | nombre de rattrapages vérifiés |
| `/setformat <n>` | style du message de prédiction (1-77) |
| `/formats` | liste des styles |
| `/apercu <n>` | aperçu complet d'un style (⌛ / ✅ / ❌) |
| `/settemplate <texte>` / `/notemplate` | style personnalisé |
| `/sethand joueur\|banquier` | main dont on lit les costumes et le B |
| `/canaux`, `/activer <id>`, `/desactiver <id>` | gestion des canaux |
| `/stats`, `/reglages` | suivi |

## Stratégie « absent apparue » (nouvelle)

Moteur indépendant du compteur B classique, qui tourne en parallèle :

1. **Suivi** : pour chaque costume, on compte les absences consécutives dans
   la main du joueur (1 → 4). À 4, le costume est « suivi » (on n'incrémente
   plus, on attend juste qu'il réapparaisse).
2. **Prédiction (site uniquement)** : dès que le costume suivi réapparaît au
   tour A, on prédit son retour au tour **A + 4**, vérifié avec **2
   rattrapages**. Cette prédiction n'est **jamais envoyée seule** sur le
   canal Telegram — elle n'apparaît que dans le tableau de bord web.
3. **Relais vers Telegram** : on surveille la suite gagné/perdu de cette
   stratégie. Dès qu'une perte survient, elle devient la référence ; on
   cherche la perte suivante (N = nombre de gains entre les deux). On
   relaie alors sur le canal Telegram dédié la **(N+1)ème prédiction créée
   après cette 2ème perte** :
   - perdu, perdu → la 1ère suivante
   - perdu, gagné, perdu → la 2ème suivante
   - perdu, gagné, gagné, perdu → la 3ème suivante
   - perdu, gagné, gagné, gagné, perdu → la 4ème suivante
   - perdu, gagné, gagné, gagné, gagné, perdu → la 5ème suivante

   Cette 2ème perte devient aussitôt la nouvelle référence, et le cycle
   recommence en continu.

Commandes : `/reglagesabsent`, `/canalabsent <id>` (canal relais dédié),
`/absentstats`, `/absenton`, `/absentoff`. Le canal relais et l'activation
sont aussi réglables via le tableau de bord (`/api/absent`,
`/api/absent/channel`, `/api/absent/toggle`). Le seuil (4), le décalage
(+4) et les rattrapages (2) sont **fixes**, non modifiables.

## API web

`/api/state` (état complet : réglages, jeu live, prédictions, canaux, bot),
`/api/games?limit=30` (derniers jeux suivis en mémoire),
`/api/absent` (état + prédictions de la stratégie « absent apparue »).

## Choisir un style de prédiction

1. `/formats` → liste des 77 styles (3 pages : `/formats 2`, `/formats 3`)
2. `/apercu 3` → aperçu du style en ⌛ / ✅ / ❌
3. `/setformat 3` → applique le style
4. `/settemplate 🎯 #{game} | {emoji} {suit} | {status}` → style 100 % personnalisé
   (`/notemplate` pour revenir aux styles numérotés)
