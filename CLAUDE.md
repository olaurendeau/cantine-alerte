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
  signalera dès leur première apparition. Il remonte dans les journaux du cron et dans le champ
  `etatsNonRepertories` de la réponse de `/api/cron`, pas seulement dans le CLI : le cron est le
  seul des deux à tourner tous les jours.
- **Phase 2 — faite.** App Next.js : inscription par lien magique, réglages (identifiants portail,
  destinataires multiples, jours de rappel), cron quotidien, envoi par Brevo, page d'administration.

## Commandes

Node >= 22 (testé sur v24 — le TypeScript est exécuté nativement, d'où les extensions `.ts`
explicites dans les imports). Next 16, Drizzle, Postgres.

```bash
cp .env.example .env
docker compose up --build   # stack complète : db + migrations + app sur :3000
npm test                    # tests unitaires (analyser, dates, décision, retry, crypto)
npm run test:tz             # tests de dates sous UTC, Paris, Auckland, Los Angeles
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
node scripts/apercu-mail.ts                             # rend les 8 variantes de mail dans apercu/
node scripts/tester-mail.ts moi@exemple.fr              # envoie un vrai gabarit
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

La mise en forme n'appartient pas à `lib/portail`, qui ne connaît que le portail : elle vit dans
`lib/mail`. C'est ce qui permet de refondre les mails sans toucher au métier.

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
  `SESSION_SECRET` signe les deux, plus les liens de désabonnement : sa longueur est contrôlée au
  même titre que celle de `CANTINE_CLE_CHIFFREMENT`, une valeur courte laisserait tout forger.

Points de conception qui ont une raison d'être :

- **Anti-doublon par contrainte d'unicité** sur `envois(parent_id, semaine_visee, jours_avant,
  type)`. L'insertion `onConflictDoNothing()` ne rend aucune ligne si le message est déjà parti — il
  n'est alors pas envoyé. C'est ce qui rend `/api/cron` rejouable sans risque, et donc le filet
  GitHub Actions inoffensif. `type` fait partie de la clé : sans lui, une confirmation posée à 16 h
  occuperait le créneau et **étoufferait le rappel** que le passage de 19 h déclencherait si une
  réservation venait d'être annulée — exactement le cas que le filet est censé rattraper.
  L'autre sens, lui, ne doit **pas** passer : `traiterParent` refuse explicitement une confirmation
  quand un rappel est déjà parti le même jour pour la même semaine. Sans ce garde, le parent qui
  réserve après son rappel de 16 h recevrait à 19 h un second message lui annonçant que tout va
  bien. La clé d'unicité ne peut pas s'en charger, puisque `type` en fait justement partie.
- ⚠️ **La ligne d'envoi est posée avant l'expédition, et libérée si celle-ci échoue.** L'ordre est
  volontaire : la ligne est le verrou anti-doublon, elle doit exister avant l'envoi. Mais la laisser
  après un échec ferait conclure au rejeu que le message est déjà parti, et transformerait une panne
  passagère de l'expéditeur en **rappel définitivement perdu** — le seul échec vraiment grave de ce
  service. D'où le `db.delete(envois)` compensatoire dans `traiterParent`. Ne pas « simplifier » en
  déplaçant l'insertion après l'envoi : deux exécutions concurrentes enverraient alors deux mails.
  Le raisonnement vaut aussi pour un envoi **partiel** : `envoyerBrevo` classe chaque échec par
  adresse en rattrapable (429, 5xx, réseau) ou définitif (4xx, adresse refusée). Un échec
  rattrapable lève, donc libère le verrou et laisse le rejeu du soir retenter ; un échec définitif
  se contente d'un `console.error`, sinon une faute de frappe dans les destinataires ferait
  renvoyer le message à tout le foyer à chaque passage.
- ⚠️ **Un échec d'expédition n'est pas un échec du portail.** Il rend le statut `echec_envoi` et ne
  repasse **pas** par `echec()` / `alerter()` : le portail a répondu, `succes()` vient de le
  consigner, et l'y renvoyer écraserait ce succès par une « dernière erreur » citant l'expéditeur,
  afficherait au parent une panne inexistante et remettrait `alerte_echec_le` à zéro à chaque cycle
  — soit une alerte par jour au lieu d'une par série. Prévenir par mail n'aurait de toute façon
  aucune chance d'aboutir : c'est l'expéditeur qui est en panne. Le signal passe par le décompte
  par statut de `/api/cron` et par les journaux Vercel.
- **Le throttling du portail s'applique par adresse IP**, pas par compte. Constaté en conditions
  réelles : trois connexions ratées d'affilée ont fait retourner un `429` au compte suivant, pourtant
  valide. D'où (a) la pause `CANTINE_PAUSE_MS` entre familles dans la boucle du cron, (b)
  `ErreurTemporaire` distincte d'`ErreurIdentifiants`, (c) aucun réessai sur un `429` — insister
  prolonge le blocage. Le `429` est classé aux **deux** endroits qui interrogent le portail :
  `login` et `getPrestations`. ⚠️ Le classement se fait par `refuserSiIndisponible()`, appelé
  **avant toute lecture de la réponse**, aux quatre sauts de connexion comme sur les prestations.
  L'ordre n'est pas cosmétique : une page d'erreur 502 ne contient aucun JWT, ce qui se lisait
  sinon comme un changement de HTML — donc une `ErreurStructure`, jamais rejouée — et transformait
  un hoquet passager du portail en rappel perdu pour la journée.
- **Trois familles d'erreurs, trois politiques de réessai** (`nePasRejouer`, `lib/reessayer.ts`) :
  `ErreurIdentifiants` (jamais rejouée — insister ferait verrouiller le compte), `ErreurTemporaire`
  (rejouée sur 5xx, jamais sur 429), `ErreurStructure` (jamais rejouée). Cette dernière couvre tout
  ce qui relève du parsing : champ caché absent, JSON illisible, `data.pointages` manquant, aucune
  prestation correspondante — plus les statuts inattendus sur un point d'entrée documenté (401,
  403, 404). La réponse sera identique au coup suivant, et chaque tentative refait les quatre sauts
  de connexion — donc pousse vers le `429` qu'on s'applique à éviter.
- **Tous les appels sortants ont un délai maximal** (`AbortSignal.timeout`) : 15 s par requête vers
  le portail, 10 s vers Brevo. `fetch` attend indéfiniment par défaut ; le cycle est séquentiel dans
  une fonction plafonnée à 300 s, donc une seule connexion qui pend priverait de rappel toutes les
  familles suivantes, sans laisser de trace. Le délai par requête ne suffit pas à borner une
  famille : la connexion fait quatre sauts et `goSuivi` en suit jusqu'à cinq de plus, chacun
  repartant de zéro, soit 150 s au pire. D'où le **budget de session** de 45 s, un seul signal créé
  par `nouvelleSession()` et combiné par `AbortSignal.any()` à chaque requête.
- **Une famille en échec n'interrompt jamais le cycle.** `traiterParent` est encadré dans la boucle,
  et `alerter()` est entièrement défensif : c'est du code qui s'exécute déjà dans la branche
  d'erreur, souvent parce que l'expéditeur est en panne. Un mail d'alerte perdu est bénin, un
  rappel perdu ne l'est pas.
- **Ne désactiver un compte que sur identifiants refusés.** Une panne du portail ou un `429` ne doit
  jamais suspendre un compte valide, sinon une indisponibilité couperait le service pour tout le
  monde. Le mail d'échec technique dit d'ailleurs explicitement au parent que ses identifiants ne
  sont pas en cause.
- **Une seule alerte par série d'échecs** (`alerte_echec_le`, remis à `null` à la première
  réussite). Le drapeau n'est posé que si le mail au parent est **effectivement parti** : sinon un
  expéditeur en panne ferait taire l'alerte pour toute la série.
- **Les rappels sont exprimés en jours de semaine** dans l'UI (`libelleJourAvant`) : l'échéance étant
  toujours un lundi, J-1 = dimanche et J-3 = vendredi. « samedi » parle à un parent, « J-2 » non.
  Plage utile 0..6 — au-delà on retomberait sur l'échéance précédente.
- **On écrit aussi quand tout va bien.** Une boîte vide est ambiguë : le parent ne peut pas
  distinguer « tout est réservé » d'un service en panne. `decider()` (fonction pure, testée) rend
  `rappel` / `confirmation` / `silence`. Le stockage est en **négatif** (`rappels.joursSilencieux`)
  pour que la liste vide — donc le défaut — vaille « confirmer partout », et qu'ajouter un jour de
  rappel n'oblige pas à penser à activer sa confirmation. Un manquant déclenche toujours un rappel,
  même un jour marqué silencieux : le silence ne concerne que les confirmations.
- ⚠️ **« Rien à confirmer » se mesure aux repas réservés, jamais au nombre de pointages.**
  `decider()` rend `silence` quand `manquants === 0` **et** `reserves === 0` : pendant les vacances
  confirmer annoncerait au parent une semaine couverte pour zéro repas. Le piège est que le portail
  ne renvoie pas une fenêtre vide pendant les vacances — il renvoie chaque jour en
  `ETAT_PRESTATION_FERMEE` et `disabled`. Compter `retenus` ferait donc croire à une semaine pleine,
  et le garde ne se déclencherait jamais : c'est le bug qu'un test de bout en bout garde désormais
  dans `tests/prestations.test.ts`. Le statut `rien_a_verifier` distingue ce cas de
  `rien_a_signaler` dans les journaux, et `verifierMaintenant` fait la même distinction — c'est
  l'écran où le parent vérifie que le service fonctionne.
- **La page admin ne charge jamais `mdp_chiffre` ni `portail_email`.** L'administrateur n'a aucun
  besoin des identifiants des familles : la requête ne les sélectionne pas.
- ⚠️ **La réponse de `/api/cron` est agrégée, sans aucune adresse.** Elle transite par le filet
  GitHub Actions, dont les journaux sont publics puisque le dépôt l'est : y laisser le détail
  nominatif publierait la liste des familles inscrites. Le détail reste dans `console.log`, donc
  dans les journaux Vercel, qui sont privés.
- **Les demandes de lien magique sont bornées** (`lib/auth/liens.ts`) : au plus 10 jetons vivants
  par compte et 20 émissions par minute au global. La page est publique et chaque appel envoie un
  mail ; sans plafond elle sert de relais d'envoi. Les deux compteurs se lisent sur
  `liens_magiques`, sans table ni service supplémentaire — un jeton n'a pas de date de création,
  mais `expire_le` vaut toujours création + 20 min, la fenêtre s'en déduit. Le refus est
  **silencieux** : la page affiche le même message quoi qu'il arrive, sinon la réponse révélerait
  quelles adresses sont inscrites. C'est précisément ce silence qui interdit de serrer le plafond
  par compte : un lien non cliqué reste vivant 20 min, un parent dont le mail tombe en indésirables
  redemande deux ou trois fois, et un plafond à 3 lui refusait le quatrième essai en continuant
  d'afficher « un lien vient de vous être envoyé ». ⚠️ **Les deux plafonds se vérifient avant toute
  écriture** : créer le compte d'abord laissait un appelant anonyme remplir `parents` à volonté,
  une ligne par requête, tout en étant refusé à l'envoi.
- **`next.config.ts` pose les en-têtes de sécurité** (CSP, HSTS, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`). `script-src` et `style-src` gardent `'unsafe-inline'` :
  Next injecte son script d'hydratation en ligne, s'en affranchir demanderait un middleware à
  nonces. L'essentiel de la valeur est ailleurs — `frame-ancestors` et `form-action`.
  `'unsafe-eval'` n'est ajouté qu'en développement, où React s'en sert pour ses messages d'erreur
  enrichis : `headers()` s'applique aussi sous `next dev`, et sans cette exception la seule boucle
  d'itération documentée ici tourne avec une console pleine de violations CSP.
- **La CI (`.github/workflows/ci.yml`) joue `typecheck`, `test` et `test:tz` à chaque poussée.**
  Les tests sont purs : ni base, ni réseau, ni secret, donc rien à configurer.

## Les mails

Cinq messages — rappel, confirmation, lien de connexion, échec parent, échec admin — tous construits
par `lib/mail/messages.ts` sur le gabarit partagé `lib/mail/gabarit.ts`.

**Un bloc rend ses deux formats.** `type Bloc = { html: string; texte: string }` : le HTML et le
texte sortent de la même source. Le travers habituel est une version texte écrite une fois puis
oubliée, qui finit par mentir ; ici, ajouter un bloc oblige à écrire ses deux rendus. Le texte n'est
pas décoratif — il sert de repli, et son absence pénalise la délivrabilité.

Contraintes de rendu à ne pas « simplifier » :

- **Tableaux et styles en ligne.** Gmail supprime `<style>` pour les comptes non-Gmail, Outlook rend
  via le moteur de Word : ni flexbox ni grid. Le `<style>` ne porte que des améliorations.
- **Bouton en tableau**, pas un `<a>` stylé : Outlook ignore `padding` et `background` sur un lien
  seul, le bouton y deviendrait un texte nu.
- **`echapper()` sur toute donnée non littérale.** Les prénoms viennent du portail, les motifs
  d'erreur de messages tiers. En texte brut le risque n'existait pas ; en HTML c'est une injection.
- **Preheader** masqué portant l'échéance : c'est lui qui rend le mail utile depuis la liste des
  messages, sans l'ouvrir.
- **Ni blanc ni noir purs**, pour rester lisible quand un client inverse les couleurs.
- Le poids du bouton suit l'urgence : `ton: "secondaire"` sur la confirmation, un bouton plein sur
  un message disant « rien à faire » invitant à cliquer sans raison.

`node scripts/apercu-mail.ts` rend les huit variantes dans `apercu/`, avec un index qui les compare
à 375 px et 600 px. Un aperçu navigateur valide la mise en page, **pas** la compatibilité :
`scripts/tester-mail.ts` envoie un vrai gabarit pour relecture dans un client réel.

**Lien de connexion** : le mail pointe vers `/connexion/verifier`, une page qui **ne consomme
rien** au chargement et propose un bouton. Les passerelles de sécurité des messageries (Outlook Safe
Links, Proofpoint) suivent les liens des mails pour les inspecter : un jeton à usage unique brûlé
par un simple `GET` le serait par un robot avant même que le parent ne clique, et celui-ci lirait
« lien invalide » sans comprendre. `/api/auth/verifier` subsiste et redirige vers cette page, pour
les mails déjà partis. Même raisonnement que pour le désabonnement ci-dessous.

**Désabonnement** : lien signé HMAC (`lib/auth/desabonnement.ts`), sans ligne en base. La page
`/desabonnement` confirme par un bouton au lieu d'agir au chargement — les passerelles de sécurité
et antivirus suivent les liens des mails, un désabonnement sur simple `GET` serait déclenché par un
robot à l'insu du parent.

## Conventions

Code et commentaires en français. **Pas d'accents dans les identifiants, les commentaires et les
messages techniques** (journaux, erreurs internes) ; en revanche le texte lu par les utilisateurs —
mails et JSX — est écrit en français correctement accentué. Un parent ne doit pas recevoir
« a reserver avant l'echeance ».

Les imports portent l'extension `.ts` explicite : Node exécute le TypeScript en mode « strip-only »,
qui l'exige et qui refuse par ailleurs les propriétés de paramètre de constructeur et les `enum`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
