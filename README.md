# Alerte cantine

Rappelle aux parents de réserver la cantine **avant que l'échéance du portail ne passe**.

Sur les portails 3D Ouest / logiciel-enfance, les réservations d'une semaine ferment le **lundi à
minuit pour la semaine suivante**. Passé ce délai, il n'y a plus de recours : l'enfant n'a pas de
repas. Ce service se connecte au portail à la place du parent, repère les repas non réservés de la
semaine en jeu, et envoie un rappel par mail les jours choisis.

Il ne réserve rien : il lit et il alerte.

## Démarrage rapide

Tout en conteneur — Postgres, migrations et application :

```bash
cp .env.example .env          # puis remplir (voir plus bas)
docker compose up --build     # http://localhost:3000
```

Les migrations tournent dans un conteneur dédié qui s'exécute puis sort ; l'application ne démarre
qu'après sa réussite, donc jamais sur une base sans tables.

Pour itérer sur le code, `next dev` en natif est plus confortable, en réutilisant le Postgres du
compose :

```bash
docker compose up -d db
npm install && npm run db:migrer
npm run dev
```

Le `.env` livré pointe sur `localhost:5433` pour ce cas ; le compose surcharge `DATABASE_URL` vers le
service `db` pour les conteneurs. Les deux modes coexistent sans rien changer.

Avec `MAIL_PROVIDER=console` (le défaut), les mails — y compris les liens de connexion — sont
affichés dans le terminal. Aucun compte chez un fournisseur d'envoi n'est nécessaire pour
développer.

### Commandes dans les conteneurs

Le service `outils` embarque les sources et l'intégralité de `node_modules`, ce que la sortie
autonome de Next n'a pas :

```bash
docker compose run --rm outils node scripts/seed.ts --rappels 0,1,4
docker compose run --rm outils node scripts/cron.ts --date 2026-09-10
docker compose run --rm outils node scripts/verifier.ts --verbose
docker compose run --rm outils npm test
```

### Déclencher le cron en local

Il faut d'abord un compte à traiter, avec un jour de rappel qui tombe aujourd'hui :

```bash
docker compose run --rm outils node scripts/seed.ts --rappels 0,1,2,3,4,5,6
```

**Par la ligne de commande** — le plus direct, ni HTTP ni secret, et le mail s'affiche dans votre
terminal :

```bash
docker compose run --rm outils node scripts/cron.ts
docker compose run --rm outils node scripts/cron.ts --date 2026-09-10 --verbose
```

**Par HTTP** — exerce exactement ce que Vercel appellera, en-tête d'autorisation compris :

```bash
curl -H "Authorization: Bearer $(grep '^CRON_SECRET=' .env | cut -d= -f2)" \
  "http://localhost:3000/api/cron?date=2026-09-10"
```

⚠️ Par cette voie, **le mail part dans les logs du conteneur, pas dans votre terminal** :
`docker compose logs -f app`. La réponse HTTP ne contient que le résumé JSON.

Le paramètre `?date=` exige `CANTINE_AUTORISER_DATE_SIMULEE=1`, que le compose définit pour le
service local et qui reste absent en production — la date choisit la semaine vérifiée, s'en servir
en vrai enverrait des rappels pour la mauvaise échéance.

**Le piège** : rejouer le même jour renvoie `deja_notifie` sans envoyer de mail, c'est l'anti-doublon.
Pour retester un envoi :

```bash
docker exec cantine-db psql -U cantine -d cantine -c "DELETE FROM envois;"
```

Enfin, `--date` déplace la semaine examinée, **pas l'état du portail**, qui reste celui d'aujourd'hui.
Choisissez une date dont la semaine cible n'est pas encore réservée pour voir un rappel se déclencher.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Postgres. En local, celui du `docker compose`. |
| `CANTINE_CLE_CHIFFREMENT` | Clé AES 32 octets base64 (`openssl rand -base64 32`). **Une clé différente par environnement.** |
| `SESSION_SECRET` | Signature des cookies de session. |
| `CRON_SECRET` | Protège `/api/cron`. Vercel l'envoie en `Authorization: Bearer`. |
| `APP_URL` | Base publique, sert à construire les liens de connexion. |
| `ADMIN_EMAILS` | Adresses des administrateurs, séparées par des virgules. |
| `MAIL_PROVIDER` | `console` (défaut) ou `brevo`. |
| `BREVO_API_KEY`, `MAIL_EXPEDITEUR` | Requis si `MAIL_PROVIDER=brevo`. |
| `CANTINE_BDD`, `CANTINE_API_KEY`, `CANTINE_DB_ID`, `CANTINE_TYPE_ID`, `CANTINE_PORTAIL` | Identifient la collectivité. Valeurs par défaut : L'Argentière-la-Bessée. |
| `CANTINE_PRESTATION` | Regex de la prestation surveillée (défaut `RepE|Repas enfant`). |
| `CANTINE_EXCLUSIONS` | Dates à ignorer, `YYYY-MM-DD` séparées par des virgules. |

**Déployer pour une autre commune** : ouvrez la page de connexion de votre portail et relevez les
champs cachés `api_key`, `type` et `db` du formulaire, ainsi que le nom de base dans l'URL. Puis
lancez `node scripts/verifier.ts --dump` pour vérifier que la prestation ciblée est la bonne.

## Outils en ligne de commande

```bash
node scripts/verifier.ts --date 2026-09-08,2026-09-14   # simule des jours, affiche les rappels
node scripts/verifier.ts --dump 2>/dev/null | jq        # payload brut du portail
node scripts/verifier.ts --verbose                      # trace chaque étape HTTP
node scripts/cron.ts --date 2026-09-10                  # exécute un cycle de rappel
node scripts/seed.ts --rappels 0,1,4                    # crée un compte de test
npm test                                                # tests unitaires
```

`scripts/verifier.ts` s'appuie sur la même bibliothèque que l'application : il ne peut pas diverger
du comportement réel.

## Déploiement (Vercel + Neon)

**1. Base Neon.** Créer un projet. Neon donne **deux URL de connexion**, et la distinction est
importante :

| URL | Hôte | Usage |
|---|---|---|
| *Pooled* | `ep-xxx-**pooler**.region.aws.neon.tech` | l'application (`DATABASE_URL`) |
| *Direct* | `ep-xxx.region.aws.neon.tech` | les migrations (`DATABASE_URL_MIGRATION`) |

Les migrations **exigent la connexion directe** : le pooler PgBouncer tourne en mode transaction et
ne conserve pas l'état de session, dont les outils de migration et le verrou de concurrence ont
besoin. `scripts/migrer.ts` avertit si vous lui passez une URL en `-pooler`.

**Les migrations s'exécutent à chaque déploiement** via le script `vercel-build`, qui enchaîne
`node scripts/migrer.ts && next build`. Il n'y a donc rien à lancer à la main : renseignez
simplement `DATABASE_URL_MIGRATION` et déployez. Deux déploiements simultanés sont sérialisés par un
verrou consultatif Postgres, sinon le second échouerait sur un `relation already exists`.

Pour initialiser depuis votre poste sans attendre un déploiement :

```bash
DATABASE_URL_MIGRATION="postgres://...neon.tech/neondb?sslmode=require" npm run db:migrer
```

Le script relit ensuite la liste des tables et **échoue si l'une manque**, plutôt que d'annoncer un
succès sur une base incomplète.

Les migrations sont des fichiers versionnés dans `drizzle/`, rejouables à l'identique — préférez-les
à `db:pousser`, qui décide seul des altérations.

> ⚠️ Repartir de zéro demande de supprimer **deux** schémas. Drizzle tient son journal dans un schéma
> `drizzle` distinct : vider `public` seul le laisse croire que tout est appliqué, et il ne rejoue
> rien.
> ```bash
> psql "$DATABASE_URL_MIGRATION" -c 'DROP SCHEMA IF EXISTS public CASCADE;
>   DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;'
> ```

**2. Variables d'environnement Vercel** (Settings → Environment Variables), pour l'environnement
Production : `DATABASE_URL` (pooled), `DATABASE_URL_MIGRATION` (directe), `CANTINE_CLE_CHIFFREMENT`,
`SESSION_SECRET`, `CRON_SECRET`, `APP_URL`, `ADMIN_EMAILS`, `MAIL_PROVIDER=brevo`, `BREVO_API_KEY`,
`MAIL_EXPEDITEUR`.

⚠️ Une preview qui hérite du `DATABASE_URL_MIGRATION` de production **migrera la base de
production**. Donnez à l'environnement Preview sa propre base, ou ne définissez ces variables que
pour Production.

⚠️ Générez une **clé de chiffrement différente** pour Preview et Production. Si les deux pointent sur
la même, n'importe quelle preview de PR peut déchiffrer les mots de passe de production.

**3. Déployer.** `vercel.json` fixe la région `cdg1` (le portail et les parents sont en France) et la
planification. La région par défaut est en Virginie, ce qui ajouterait un aller-retour transatlantique
par famille.

### Le cron

Il se configure **entièrement par `vercel.json`**, il n'y a rien à créer dans l'interface :

```json
{ "crons": [{ "path": "/api/cron", "schedule": "0 16 * * *" }] }
```

À savoir :

- **Les tâches planifiées ne s'enregistrent qu'au déploiement en production.** Une preview ne
  déclenche rien. Après déploiement, vérifier dans Settings → Cron Jobs, qui donne aussi « View Logs ».
- **`CRON_SECRET` suffit à sécuriser l'endpoint** : dès que la variable existe, Vercel envoie
  `Authorization: Bearer <CRON_SECRET>` à chaque invocation. `/api/cron` refuse tout le reste par un
  401 — y compris si la variable n'est pas définie, plutôt que de s'ouvrir par défaut.
- **16 h UTC** = 18 h à Paris en été, 17 h en hiver. Avec l'imprécision Hobby de ±59 min, le pire cas
  reste 18 h 59 heure de Paris, donc bien avant l'échéance de minuit.
- **Les tâches planifiées ne suivent pas les redirections** : un endpoint qui répond en 3xx est
  considéré comme terminé. `/api/cron` répond en JSON.
- **La livraison est au mieux** : Vercel peut manquer une exécution *et* peut en déclencher deux. Les
  deux cas sont couverts — la contrainte d'unicité sur `envois` rend un double déclenchement
  inoffensif, et le workflow GitHub Actions rattrape une exécution manquée.
- **Aucun réessai** en cas d'échec, et sur le plan **Hobby une seule exécution par jour** (une
  expression plus fréquente fait échouer le déploiement). C'est suffisant puisque l'unité de rappel
  est la journée.

Le filet de sécurité `.github/workflows/rappel.yml` rappelle le même endpoint trois heures plus tard.
Définir les secrets `APP_URL` et `CRON_SECRET` dans le dépôt GitHub.

Pour tester sans attendre :

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://votre-app.vercel.app/api/cron
```

## Configurer l'envoi de mails (Brevo)

En développement, rien à faire : `MAIL_PROVIDER=console` affiche les mails dans le terminal. Brevo
n'est nécessaire que pour envoyer réellement.

**1. Créer un compte** sur brevo.com. Le plan gratuit couvre 300 mails par jour — largement au-delà
du besoin, un foyer recevant au plus un message par jour de rappel choisi.

**2. Authentifier votre domaine** (Paramètres → Expéditeurs, domaines & IPs dédiées). Vous ajoutez
un code Brevo, un enregistrement DKIM et un DMARC dans votre DNS. Une fois le domaine authentifié,
tous les expéditeurs de ce domaine sont validés d'office.

⚠️ **N'utilisez pas une adresse Gmail/Free/Orange comme `MAIL_EXPEDITEUR`.** Si l'adresse
d'expédition est sur un domaine gratuit ou non authentifié, Brevo **remplace votre adresse** par une
adresse générique conforme. Le parent reçoit alors un mail d'un expéditeur qu'il ne reconnaît pas —
la première réaction est de le marquer comme spam, ce qui dégrade la délivrabilité de tous les
suivants. C'est le piège numéro un.

**3. À défaut de domaine**, créer un expéditeur unique (Paramètres → Expéditeurs) et le valider avec
le code à 6 chiffres reçu par mail. Utilisable pour tester, mais l'avertissement ci-dessus
s'applique.

**4. Créer une clé API** dans les paramètres du compte, section SMTP & API → clés API. C'est une clé
**API v3**, pas une clé SMTP : l'application appelle `api.brevo.com/v3/smtp/email` avec l'en-tête
`api-key`.

**5. Renseigner l'environnement** :

```bash
MAIL_PROVIDER=brevo
BREVO_API_KEY=xkeysib-...
MAIL_EXPEDITEUR=cantine@votre-domaine.fr    # doit être validé côté Brevo
MAIL_EXPEDITEUR_NOM=Alerte cantine
```

**6. Vérifier** sans attendre un rappel :

```bash
node scripts/tester-mail.ts vous@exemple.fr
docker compose run --rm outils node scripts/tester-mail.ts vous@exemple.fr
```

Le script affiche le fournisseur et l'expéditeur utilisés, puis traduit les échecs courants : un 401
désigne la clé, un 400 mentionnant `sender` désigne un expéditeur non validé.

Un mail est envoyé **par destinataire** plutôt qu'un seul à plusieurs adresses : sinon les
destinataires d'un même foyer se verraient mutuellement dans le champ `À`, ce qui n'est pas
souhaitable dès qu'on y ajoute un grand-parent ou une nounou. Une adresse invalide n'empêche pas les
autres de recevoir leur rappel.

## Sécurité et vie privée

Le service stocke le mot de passe du portail de chaque famille, chiffré en AES-256-GCM. La clé
n'est **pas** en base : une copie de la base de données ne permet pas de retrouver les mots de
passe. Le chiffré est lié au compte, il ne peut pas être rejoué ailleurs. Aucune route ne renvoie
un mot de passe : l'interface permet seulement de le remplacer.

**Le service reste techniquement capable de déchiffrer ces mots de passe**, puisqu'il doit se
connecter au portail en l'absence du parent. Ce n'est donc pas du chiffrement de bout en bout, et
c'est dit tel quel aux parents sur la page `/confidentialite`. Le code étant public, l'affirmation
est vérifiable.

L'administrateur dispose d'une page listant les comptes et leur état de fonctionnement. Elle ne
charge ni les mots de passe, ni même les identifiants portail des familles.

## Licence

MIT.
