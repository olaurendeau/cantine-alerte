# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Objectif

Alerter les parents quand une réservation de cantine / périscolaire n'a pas été faite à temps sur le
portail **3D Ouest / logiciel-enfance** (école d'Argentière). La collectivité impose de réserver
**avant le lundi minuit, 7 jours avant la semaine concernée** — passé ce délai il n'y a plus de
solution, d'où l'alerte.

Feuille de route :

- **Phase 1 — faite.** Flow d'auth validé de bout en bout, structure du payload élucidée, parsing
  calé dessus et **recoupé écran par écran** avec l'UI du portail (`docs/screenshots-ui/`), règle de
  blocage déduite des données. Restent non observés dans l'API deux états que la légende annonce :
  « Pré-réservé » et « En attente et bloqué » — l'avertissement sur état non répertorié les
  signalera dès leur première apparition.
- **Phase 2 — faite.** App Next.js : inscription par lien magique, réglages (identifiants portail,
  destinataires multiples, jours de rappel), cron quotidien, envoi par Brevo, page d'administration.

## Commandes

Node >= 22 (testé sur v24 — le TypeScript est exécuté nativement, d'où les extensions `.ts`
explicites dans les imports). Next 16, Drizzle, Postgres.

```bash
cp .env.example .env
docker compose up --build   # stack complète : db + migrations + app sur :3000
npm test                    # tests unitaires (dates, retry, crypto)
npm run typecheck
npm run db:migrer           # applique drizzle/*.sql
npm run db:generer          # génère une migration après modif du schéma
```

Pour itérer sur le code, `npm run dev` en natif contre le Postgres du compose (`docker compose up -d
db`). Le `.env` pointe sur `localhost:5433` pour ce cas ; le compose surcharge `DATABASE_URL` vers le
service `db` pour les conteneurs. Les deux modes coexistent.

⚠️ La sortie autonome de Next (`output: "standalone"`) n'est activée que par
`NEXT_SORTIE_AUTONOME=1`, posé dans le `Dockerfile`. **Ne jamais l'activer inconditionnellement** :
Vercel fait son propre traçage de fichiers après le build et les deux se marchent dessus. Le build
réussit puis l'empaquetage échoue sur `ENOENT: .next/next-server.js.nft.json`, ce qui envoie
chercher le problème au mauvais endroit.

Le `Dockerfile` a deux cibles : `runner` (sortie autonome Next, ce qui tourne dans le conteneur) et
`outils` (sources + `node_modules` complet). Les scripts et `drizzle-kit` **ne sont pas** dans la sortie
autonome, d'où la seconde cible — c'est elle qui exécute migrations, seed et CLI :
`docker compose run --rm outils node scripts/cron.ts --date 2026-09-10`.

Outils en ligne de commande, tous appuyés sur `lib/portail` — donc incapables de diverger de l'app :

```bash
node scripts/verifier.ts --date 2026-09-08,2026-09-14   # simule des jours, affiche les rappels
node scripts/verifier.ts --dump 2>/dev/null | jq        # payload brut (stdout = JSON pur)
node scripts/verifier.ts --verbose                      # trace chaque étape HTTP
node scripts/cron.ts --date 2026-09-10                  # exécute un cycle de rappel complet
node scripts/seed.ts --rappels 0,1,4                    # crée un compte de test depuis le .env
node scripts/lien.ts moi@exemple.fr                     # génère un lien de connexion
```

`--date` accepte **plusieurs dates séparées par des virgules** : une seule connexion et une seule
requête couvrant l'union des fenêtres. C'est le moyen de voir la bascule normal → urgent sans
attendre le bon jour. Attention : simuler une date change la semaine examinée, **pas l'état du
portail**, qui reste celui d'aujourd'hui — simuler une date passée ne rejoue pas l'historique.

Variables d'environnement : voir `.env.example` et le tableau du `README.md`. Les valeurs par défaut
de la collectivité sont **confirmées identiques aux champs cachés servis par le portail**
d'Argentière : `CANTINE_BDD=cantine2_argentiere`, `CANTINE_API_KEY=cantine2`, `CANTINE_DB_ID=8089`,
`CANTINE_TYPE_ID=9`, `CANTINE_PORTAIL=argentiere`.

Le POC d'origine (`cantine-alerte.mjs`, script unique) a été supprimé : sa logique vit désormais
dans `lib/portail`, et `scripts/verifier.ts` en reproduit le comportement à l'identique. Ne pas le
recréer — deux implémentations de la même règle métier finiraient par diverger.

## Architecture

Le client portail (`lib/portail/`) est le cœur ; l'app web et les scripts n'en sont que deux
consommateurs. Quatre couches successives, chacune dépendante de la précédente.

### 1. Session HTTP maison

`fetch` ne persiste rien et suit les redirections par défaut. `nouvelleSession()` encapsule donc un
cookie jar (`Map` alimentée par `res.headers.getSetCookie()`) et deux helpers en `redirect: "manual"` :
`go()` pour un appel simple, `goSuivi()` qui suit une chaîne de redirections en conservant **chaque**
réponse. Toute requête vers le portail doit passer par là, sinon la session Laravel est perdue.

La session est un objet et non un global : c'est ce qui permettra d'itérer sur plusieurs familles en
phase 2 sans fuite de cookies d'un compte à l'autre.

### 2. Authentification en 4 sauts (le morceau délicat)

Deux hôtes distincts coopèrent : `connect1.3douest.com` (SSO Laravel) et
`gestion.logiciel-enfance.fr` (API métier). Flow vérifié en conditions réelles.

1. `POST /api/redirecturi` sur l'API → **token d'amorçage** (JWT, `iss: "3douestcantineserver"`),
   extrait par regex (`tokensDe`).
2. `GET /connexion?token=...` sur le SSO → pose `XSRF-TOKEN` + `laravel-session` et expose le `_token`
   CSRF plus des champs cachés (`api_key`, `type`, `db`) récupérés par `champCache()`. Ces champs
   cachés priment sur les valeurs d'environnement lors du POST.
3. `POST /connexion` avec identifiants + CSRF. **La discrimination succès/échec ne se fait pas sur le
   code HTTP** : en cas d'échec le SSO renvoie un `302` vers `/connexion?...&email=...` — donc un
   corps quasi vide, d'où la nécessité de `goSuivi()` et du balayage des tokens dans le corps, le
   `location` **et** l'URL. Le verdict se prend sur la présence d'un JWT dont l'`iss` vaut
   `"3douest-auth-server"`. Absence = identifiants refusés, throttling, ou appareil de confiance.
   `419` = session/CSRF invalide côté Laravel.
4. `POST /api/login` avec ce token → Bearer applicatif utilisé pour toute la suite.

En cas d'échec, `messagesErreur()` remonte le message du portail lui-même (ex. « Mauvais email et/ou
mot de passe. »). Le balisage est du Tailwind sans classe parlante : **c'est `role="alert"` qui
identifie le bloc, pas la classe** — ne pas « simplifier » cette regex.

Toutes les requêtes vers l'API portent l'en-tête `bdd: <CANTINE_BDD>` — c'est le sélecteur de tenant,
l'oublier renvoie des données vides ou une erreur.

Le parsing repose sur des regex (JWT et champs `<input>`) : si le portail change son HTML, c'est
`champCache()` / `tokensDe()` / `messagesErreur()` qui casseront en premier. `--verbose` trace chaque
saut, les cookies obtenus et les issuers vus — c'est l'outil de diagnostic à dégainer en premier.

### 3. Structure du payload `/api/adulte/prestations`

Vérifiée en conditions réelles. `data` contient notamment :

- **`data.pointages`** — un **dictionnaire**, pas un tableau, indexé `"<fkindividu>|<fkprestation>|<date>"`.
  Chaque valeur porte `date`, `type: "R"`, `etat` (numérique), `code_etat` (chaîne parlante),
  `disabled` (booléen) et `fkfacture`.
- **`data.prestations`** — indexé par id de prestation, chacune avec `prestation` (dont `code` et
  `libelle`), `planning` (`jour_0`..`jour_6`, `-1` = fermé, `jour_0` = lundi) et `individus`.
- **`data.individus`** — les enfants, `fkindividu` + `prenom`.

Le portail d'Argentière expose 4 prestations : `Gmat` (Garderie matin), `Gsoir` (Garderie soir),
**`RepE` (Repas enfant) — la cantine**, `ACCu` (Accueil d'urgence). Le script cible `RepE` par défaut,
surchargeable par `CANTINE_PRESTATION` (une regex testée sur `code` et `libelle`).

États rencontrés, rapprochés de la légende de l'UI. Les captures qui ont servi à ce recoupement sont
dans `docs/screenshots-ui/`, **volontairement hors dépôt** (`.gitignore`) : elles montrent les nom et
prénoms d'enfants mineurs, et ce dépôt est public. Le tableau ci-dessous suffit à travailler sans
elles.

| `code_etat` | `etat` | libellé UI | réservé ? |
|---|---|---|---|
| `ETAT_NON_RESERVE` | 0 | « Disponible à la réservation » (`+`) | non — **c'est le cas à alerter** |
| `ETAT_PRESTATION_FERMEE` | 100 | « Non disponible » (gris vide) | non |
| `ETAT_BLOCAGE` | 0 ou 100 | « Bloqué à la réservation » (cadenas gris) | non |
| `ETAT_BLOCAGE_DEPASSE` | 105 | « Bloqué à la réservation » (cadenas gris) | non |
| `ETAT_BLOCAGE_RESERVE` | 3 | « Réservé et bloqué » (cadenas vert) | oui |
| `ETAT_FACTURE` | 104 | — (facturé, `fkfacture` renseigné) | oui |

« Bloqué à la réservation » remonte sous **deux codes** selon la cause (hors période scolaire vs
échéance dépassée) ; `etat` n'est pas discriminant, c'est `code_etat` qui fait foi.

`ETATS_RESERVES` est une **liste blanche** : tout code hors liste compte comme non réservé et
déclenche en plus un avertissement `etat(s) non repertorie(s)` pour être classé. Ne pas inverser
cette asymétrie — une alerte en trop est bénigne, une alerte manquante fait rater le repas.

⚠️ **Ne jamais ajouter l'état pré-réservé à `ETATS_RESERVES`.** La prestation tourne en
`mode_fonctionnement: "prepaiement_panier"` et l'UI distingue explicitement « Pré-réservé » (icône
panier, non validé) de « Réservé » (coche verte). Compter le panier comme une réservation ferait
taire l'alerte précisément quand le parent a oublié de valider. Deux états de la légende n'ont pas
encore été observés dans l'API et restent donc non classés : « Pré-réservé » et « En attente et
bloqué à la réservation » — l'avertissement les signalera à leur première apparition.

### 4. Règle métier

**Les réservations sont à effectuer avant le lundi minuit pour la semaine suivante.** Deux fonctions
suffisent :

- `prochaineEcheance()` → prochain lundi, aujourd'hui inclus si on est lundi (la journée reste
  ouverte jusqu'à minuit) ;
- `semaineVisee()` → lundi de la semaine que cette échéance verrouille, soit échéance + 7.

Vérifié : le jeudi 2026-08-27, échéance lundi 2026-08-31 minuit (J-4), semaine visée 2026-09-07.
`--semaines N` élargit aux semaines suivantes (encore ouvertes, non urgentes) ; le défaut de 1 est le
bon cadrage.

Les dates sont épinglées à midi UTC, et **`aujourdhuiParis()` force explicitement le fuseau
`Europe/Paris`** au lieu de lire les composantes locales du serveur. Vercel tourne en UTC : un run
après 22 h UTC en été tomberait déjà au lendemain à Paris et viserait la mauvaise semaine. Les tests
`tests/dates.test.ts` passent sous `TZ=UTC`, `Europe/Paris`, `Pacific/Auckland` et
`America/Los_Angeles`, et couvrent les deux bascules d'heure de 2026.

⚠️ **Ne pas essayer de déduire la semaine visée des données** en cherchant la première semaine encore
modifiable. Ça a été tenté et c'est faux : le portail fonctionne en `prepaiement_panier`, donc une
réservation validée et payée bascule en `ETAT_BLOCAGE_RESERVE` (« Réservé et bloqué ») **immédiatement**,
bien avant son échéance. Une semaine déjà réglée paraît donc verrouillée sans avoir jamais été en
retard, et la première semaine « ouverte » peut se situer plusieurs semaines après la vraie échéance.
Concrètement, le 27/08 les semaines du 07/09 et 14/09 étaient réglées d'avance : l'heuristique
désignait le 21/09 comme semaine à risque (échéance réelle : 14/09) tout en affichant « verrouillée
le 31/08 ». Le verrouillage vient du paiement, pas de l'échéance — `disabled` ne mesure donc pas le
délai.

Le champ `disabled` reste utilisé pour ce qu'il dit vraiment : ce jour n'appelle aucune action du
parent (jour non proposé, ou échéance passée). C'est ce qui permet de se passer d'un calendrier des
jours d'école — mercredi, week-ends et vacances remontent en `ETAT_PRESTATION_FERMEE`/`disabled` et
sont écartés d'office. `CANTINE_EXCLUSIONS` ne sert plus qu'aux cas que le portail ignore (sortie
scolaire avec pique-nique).

À savoir si on élargit `CANTINE_PRESTATION` au-delà de la cantine : **les prestations n'ont pas le
même délai**. Sur la capture de la semaine du 31/08, Repas enfant est verrouillé alors que Garderie
matin/soir accepte encore des réservations. La fenêtre calculée applique la règle de la cantine à
tout ce qui est surveillé.

### 5. Comparaison et notification

Un manquant est un couple **(jour, enfant)** : une réservation posée pour un seul enfant ne couvre
pas la fratrie. La notification regroupe par jour (`- lundi 21 septembre : <prenoms>`). L'alerte
passe en **urgente** quand l'échéance tombe aujourd'hui (`J-0`), ce qui change l'objet et le délai
annoncé (« ce soir avant minuit » au lieu de « dans 6 jours »).

Composition et transport sont séparés : `composerNotification()` ne fait aucune I/O et renvoie
`{urgent, objet, corps}`, que `lib/mail` envoie (`console` en développement, `brevo` en production).

## L'application

`lib/portail/` ignore tout de la base et du web. Au-dessus :

- **`lib/service/verification.ts`** — le cycle de rappel. Sélectionne les parents dont `jours_avant`
  contient le J-n du jour, déchiffre, interroge, envoie, trace. C'est ce qui permet à **une seule
  exécution quotidienne** de servir toutes les préférences de rappel.
- **`lib/service/reglages.ts`** — lecture/écriture des réglages, validation des identifiants,
  « vérifier maintenant ».
- **`lib/crypto.ts`** — AES-256-GCM, clé en variable d'environnement, **AAD = `parent_id`** pour
  qu'un chiffré recopié sur une autre ligne soit rejeté.
- **`lib/auth/`** — lien magique (seul le hash du jeton est stocké) et session en cookie signé.

Points de conception qui ont une raison d'être :

- **Anti-doublon par contrainte d'unicité** sur `envois(parent_id, semaine_visee, jours_avant)`.
  L'insertion `onConflictDoNothing()` ne rend aucune ligne si le rappel est déjà parti — le mail
  n'est alors pas envoyé. C'est ce qui rend `/api/cron` rejouable sans risque, et donc le filet
  GitHub Actions inoffensif.
- **Le throttling du portail s'applique par adresse IP**, pas par compte. Constaté en conditions
  réelles : trois connexions ratées d'affilée ont fait retourner un `429` au compte suivant, pourtant
  valide. D'où (a) la pause `CANTINE_PAUSE_MS` entre familles dans la boucle du cron, (b)
  `ErreurTemporaire` distincte d'`ErreurIdentifiants`, (c) aucun réessai sur un `429` — insister
  prolonge le blocage.
- **Ne désactiver un compte que sur identifiants refusés.** Une panne du portail ou un `429` ne doit
  jamais suspendre un compte valide, sinon une indisponibilité couperait le service pour tout le
  monde. Le mail d'échec technique dit d'ailleurs explicitement au parent que ses identifiants ne
  sont pas en cause.
- **Une seule alerte par série d'échecs** (`alerte_echec_le`, remis à `null` à la première réussite).
- **Les rappels sont exprimés en jours de semaine** dans l'UI (`libelleJourAvant`) : l'échéance étant
  toujours un lundi, J-1 = dimanche et J-3 = vendredi. « samedi » parle à un parent, « J-2 » non.
  Plage utile 0..6 — au-delà on retomberait sur l'échéance précédente.
- **On écrit aussi quand tout va bien.** Une boîte vide est ambiguë : le parent ne peut pas
  distinguer « tout est réservé » d'un service en panne. `decider()` (fonction pure, testée) rend
  `rappel` / `confirmation` / `silence`. Le stockage est en **négatif** (`rappels.joursSilencieux`)
  pour que la liste vide — donc le défaut — vaille « confirmer partout », et qu'ajouter un jour de
  rappel n'oblige pas à penser à activer sa confirmation. Un manquant déclenche toujours un rappel,
  même un jour marqué silencieux : le silence ne concerne que les confirmations.
- **La page admin ne charge jamais `mdp_chiffre` ni `portail_email`.** L'administrateur n'a aucun
  besoin des identifiants des familles : la requête ne les sélectionne pas.

## Conventions

Code, commentaires et messages en français, **sans accents dans les chaînes du code source** (les
accents ne figurent que dans les fichiers `.md` et le JSX destiné à l'affichage). Les imports
portent l'extension `.ts` explicite : Node exécute le TypeScript en mode « strip-only », qui l'exige
et qui refuse par ailleurs les propriétés de paramètre de constructeur et les `enum`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
