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
- **Phase 3 — faite.** Surveillance par jour de semaine et par prestation : la famille décoche les
  jours sans cantine, coche les jours de périscolaire matin/soir. Le périscolaire suit une **seconde
  règle d'échéance** (veille minuit), donc sa propre fenêtre. Un seul mail par jour couvre les deux.
  Un bouton dans le rappel met la cantine en silence jusqu'à la prochaine échéance.
  ⚠️ **La règle « veille minuit » du périscolaire est déduite, pas observée** : elle n'a jamais été
  confrontée au portail. `fenetresDepassees` (cf. §3) est le signal qui la dénoncerait.

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
node scripts/seed.ts --rappels 0,1,4 --matin 0,3        # crée un compte de test depuis le .env
node scripts/lien.ts moi@exemple.fr                     # génère un lien de connexion
node scripts/apercu-mail.ts                             # rend les 11 variantes dans apercu/
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
**`RepE` (Repas enfant) — la cantine**, `ACCu` (Accueil d'urgence). Trois d'entre elles sont
surveillées, chacune par sa propre regex testée sur `code` et `libelle` :

| Clé | Variable | Défaut | Requise ? |
|---|---|---|---|
| `cantine` | `CANTINE_PRESTATION` | `RepE\|Repas enfant` | **oui** — absente = `ErreurStructure` |
| `matin` | `CANTINE_PRESTATION_MATIN` | `Gmat\|Garderie matin` | non — absente = remontée dans `absentes` |
| `soir` | `CANTINE_PRESTATION_SOIR` | `Gsoir\|Garderie soir` | non — idem |

Seule la cantine est requise : une collectivité sans garderie ne doit pas casser le service pour
tout le monde. Mais le silence qui en découle doit se voir, d'où `Analyse.absentes`, remontée dans
les journaux du cron, dans `/api/cron` et dans l'écran « vérifier maintenant ».

⚠️ **Une prestation réclamée par deux motifs lève.** Ses pointages seraient comptés une fois par
fenêtre, et la config fautive passerait inaperçue derrière des chiffres simplement trop grands.

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

⚠️ **Cette distinction porte le seul garde-fou de la règle périscolaire.** `ETAT_PRESTATION_FERMEE`
dit « jour non proposé » (mercredi, vacances), `ETAT_BLOCAGE_DEPASSE` dit « échéance déjà passée ».
Un pointage de garderie à J+1 qui revient en `ETAT_BLOCAGE_DEPASSE` signifie donc que notre fenêtre
est calculée **trop tard** : on interroge des jours sur lesquels le parent ne peut plus agir, et
l'alerte n'arriverait jamais. Ces clés remontent dans `Analyse.fenetresDepassees`, dans les journaux
du cron et dans `/api/cron`. Le mode d'échec inverse — une garderie qui n'ouvrirait à la réservation
que plus tard — reste **un angle mort** : elle reviendrait en `ETAT_PRESTATION_FERMEE`, indistinguable
de vacances.

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

**Deux règles coexistent**, et c'est la source de toute la structure de `lib/portail` :

| | Échéance | Fenêtre interrogée le jour T |
|---|---|---|
| Cantine | lundi minuit, pour la semaine suivante | `[semaineVisee, semaineVisee + 6]` |
| Périscolaire matin / soir | **veille minuit** | `[T+1, T+2]` |

Pour la cantine, deux fonctions suffisent :

- `prochaineEcheance()` → prochain lundi, aujourd'hui inclus si on est lundi (la journée reste
  ouverte jusqu'à minuit) ;
- `semaineVisee()` → lundi de la semaine que cette échéance verrouille, soit échéance + 7.

Pour le périscolaire, `fenetreVeille()` : la réservation d'un jour `D` ferme au minuit qui **ouvre**
`D`, donc le dernier jour utile est `D-1` et l'avant-dernier `D-2` — vus d'aujourd'hui, `T+1` et
`T+2`. Le cron étant quotidien, chaque jour d'école est vu deux fois, le lundi par les passages du
samedi et du dimanche.

### `fenetresPour()` est le point de vérité unique

Tout le reste en découle mécaniquement. Une fenêtre cantine non construite, et il n'y a ni manquants,
ni réservés, ni section de mail, ni confirmation — **sans une seule condition ailleurs**. Porter la
même règle dans `decider()` et dans la composition du mail l'éparpillerait en conditions devant
rester d'accord entre elles.

```
jours_avant vide                      → aucune fenetre : la famille est ignoree (interrupteur general)
fenetre cantine        construite ssi  restants ∈ jours_avant  ET  pause_semaine ≠ semaine visee
fenetre matin / soir   construite ssi  la surveillance a ≥ 1 jour coche
                                       ET  jourSemaine(T+1) ou jourSemaine(T+2) y figure
aucune fenetre construite             → on n'appelle PAS le portail
```

⚠️ **`jours_avant` vide est l'interrupteur général**, pas seulement une cadence de cantine. C'est ce
que pose le lien « Ne plus recevoir de rappels ». Sans ce garde, le périscolaire — qui ne dépend pas
des jours choisis — continuerait d'écrire à une famille désabonnée, et le lien mentirait.

⚠️ **Les fenêtres ne se recouvrent pas**, mais une seule requête couvre leur union : le portail ne
filtre rien par prestation, il renvoie déjà tout sur la plage demandée. Multiplier les requêtes
entamerait le budget de session de 45 s pour rien.

Les jours attendus sont des **jours de semaine, 0 = lundi** (`jourSemaine()`), comme `planning.jour_0`
du portail. À ne pas confondre avec `jours_avant`, qui compte les jours **avant l'échéance**
(0 = lundi *dernier jour*, 6 = mardi). Deux référentiels opposés, d'où des noms nettement différents
et deux cartes séparées dans l'UI.

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
sont écartés d'office. C'est aussi le garde-fou du périscolaire : si la règle « veille minuit » est
fausse, les pointages reviennent verrouillés et l'on se tait, plutôt que d'alerter à tort.

Trois filtres distincts écartent un pointage des manquants, et ils ne se confondent pas :

- **`disabled`** — le portail a verrouillé : le parent ne peut rien y faire ;
- **`joursAttendus`** (par fenêtre) — la famille n'attend pas de réservation ce jour-là ;
- **`exclusions`** (dates absolues, `CANTINE_EXCLUSIONS`) — ⚠️ **posées sur la fenêtre cantine
  seule.** Le cas d'usage est la sortie scolaire avec pique-nique : elle supprime le repas, **pas la
  garderie du matin**, où l'enfant est déposé à la même heure.

Les deux derniers ne filtrent **que** les manquants, jamais `reserves` : un repas posé un jour non
attendu reste un repas posé, et doit continuer d'être compté — sinon la confirmation annoncerait
moins que la réalité. `ecartesParReglages()` rend ce que ces deux filtres ont masqué, pour que
l'écran « vérifier maintenant » puisse le montrer : taire ce qui a été écarté rendrait un réglage
trop restrictif indétectable.

### 5. Comparaison et notification

Un manquant est un couple **(jour, enfant)** : une réservation posée pour un seul enfant ne couvre
pas la fratrie. La notification regroupe par jour (`- lundi 21 septembre : <prenoms>`), et le
périscolaire accole le moment au jour (`jeudi 18 (matin et soir)`) — sans lui le parent ne sait pas
laquelle des deux inscriptions poser.

L'alerte passe en **urgente** quand une échéance tombe cette nuit : cantine à `J-0`, ou périscolaire
à `T+1`. Les deux disent littéralement la même chose (« ce soir avant minuit »), la formulation
reste donc vraie dans les deux cas.

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
- ⚠️ **`envois.type` porte le périmètre** : `rappel_cantine`, `rappel_periscolaire`,
  `confirmation`. Sans lui, un rappel de garderie posé à 16 h occuperait la ligne du jour, et le
  filet de 19 h conclurait « déjà notifié » si une réservation de cantine venait d'être annulée
  entre-temps — soit une **régression** du filet existant. Une journée normale compose **un** mail et
  pose **deux** lignes ; le mail expédié ne contient que les sections dont l'insertion a rendu une
  ligne, sinon on renverrait ce qui vient de partir. Le garde « pas de confirmation après un rappel »
  vaut pour **n'importe quel** rappel du jour, quel que soit son périmètre.
  ⚠️ **La migration `0003` doit convertir les lignes historiques** (`UPDATE envois SET type =
  'rappel_cantine' WHERE type = 'rappel'`), sinon elles n'entrent plus en collision et chaque
  famille reçoit un doublon le jour du déploiement. Un cron de l'**ancienne** révision encore en vol
  pendant la migration peut néanmoins réinsérer un `type = 'rappel'` après coup : fenêtre de quelques
  minutes, une seule fois, et le résultat est un mail en trop — bénin selon l'asymétrie du service.
  Drainer les crons avant de migrer l'élimine, si la question se repose un jour.
- **La pause est cantine seule, et s'exprime en semaine visée.** `rappels.pause_semaine` stocke le
  lundi visé, pas une date de fin : quand l'échéance passe, la semaine visée change, la valeur ne
  correspond plus et la cantine reprend **seule**. Rien à purger, recliquer est idempotent. Elle
  éteint **rappel et confirmation** — le parent a dit « pas de cantine cette semaine », lui annoncer
  deux jours plus tard que ses 12 repas sont réservés serait encore lui parler de cantine.
  ⚠️ Elle n'est donc **pas** filtrable en SQL : une famille en pause reste interrogée pour son
  périscolaire. C'est `fenetresPour` qui tranche.
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
- **Une famille qui active le périscolaire est interrogée tous les jours**, contre ~2 jours sur 7
  auparavant. À 3 s de pause par famille dans une fonction plafonnée à 300 s, le service tient une
  cinquantaine de comptes. Trois garde-fous, et aucun n'est décoratif :
  - `BUDGET_CYCLE_MS` (230 s) **arrête le cycle avant que Vercel ne le coupe**. Se faire couper en
    plein vol ferait disparaître le reste de la liste sans laisser la moindre trace ; s'arrêter
    soi-même permet de compter ce qu'on n'a pas fait.
  - ⚠️ **L'ordre de traitement est `verifie_le ASC NULLS FIRST`, et ce n'est pas cosmétique.** Sans
    ordre explicite, Postgres rend une liste stable en pratique : la même famille se retrouverait en
    queue à chaque cycle, donc **systématiquement** sacrifiée quand le budget s'épuise — et le filet
    de 19 h la couperait au même endroit. `verifie_le` étant remis à jour à chaque succès, une
    famille non traitée repasse mécaniquement en tête. On transforme ainsi « les mêmes dix familles
    ne sont jamais alertées » en « tout le monde finit par l'être ».
  - `dureeMs`, `interroges` et surtout **`nonTraites`** remontent dans `/api/cron`. Toute valeur non
    nulle de `nonTraites` est une alerte d'exploitation : des familles n'ont pas été examinées, leur
    rappel du jour peut être perdu.
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
- **La confirmation parle du périmètre réellement regardé, en deux lignes distinctes.** La cantine
  se confirme sur une semaine, le périscolaire sur deux jours : une phrase globale « tout est
  réservé » affirmerait une couverture de la garderie sur des jours qu'on n'a jamais regardés. Un
  passage déclenché par le seul périscolaire ne confirme donc **jamais** — d'où `jourDeNouvelles`
  dans `decider()`.
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
- **Sections dans un ordre fixe** cantine puis périscolaire, chacune portant sa propre échéance.
  L'encart de tête et l'objet portent déjà la plus pressante, donc l'ordre du corps ne joue plus sur
  l'urgence — seulement sur l'habitude de lecture, et un message récurrent dont la structure bouge se
  lit moins vite. **L'objet, lui, épouse le périmètre le plus pressant** et relègue l'autre en
  suffixe : un objet à parts égales rendrait « Dernier jour » littéralement faux pour l'un des deux.
  ⚠️ Une famille sans périscolaire doit retrouver l'objet d'origine **au caractère près** — c'est un
  test de non-régression de `tests/messages.test.ts`.
- **Le bouton de pause n'apparaît que sur un rappel contenant une section cantine.** Il ne coupe que
  la cantine : l'afficher sur un message qui ne parle que de garderie promettrait un silence qu'il ne
  tient pas. Le libellé le nomme (« Pas de cantine cette semaine ») et la page de confirmation dit
  explicitement ce qu'il **ne** coupe pas, sinon le premier mail de garderie du lendemain passerait
  pour un bug.
- **Un emoji ouvre l'objet** des rappels et des confirmations : ✅ tout est réservé, ⚠️ il manque
  des repas, 🚨 il manque des repas et l'échéance est à deux jours ou moins. C'est le premier
  caractère, donc la seule position que l'aperçu mobile ne tronque jamais. Des glyphes parlants et
  non des ronds de couleur : un rond ne dit plus rien là où le client rend les emojis en monochrome
  (Outlook pour Windows) ni à un lecteur d'écran. ⚠️ Le seuil du gyrophare (`SEUIL_PRESSE`, deux
  jours) est **volontairement plus large que `urgent`**, qui vaut J-0 seul : `urgent` commande des
  formulations vraies ce jour-là uniquement (« ce soir avant minuit », encart rouge), l'emoji
  n'affirme rien de tel et peut donc prévenir plus tôt. Ne pas les fusionner — avancer « Dernier
  jour » à J-2 rendrait le message faux et userait l'alerte avant le vrai dernier jour.
  ⚠️ **`SEUIL_PRESSE` ne se transpose pas tel quel au périscolaire.** Il a été calibré sur un cycle
  de sept jours, où « il reste deux jours » est vraiment la dernière ligne droite ; sur un cycle de
  deux jours il couvrirait tout le cycle et l'emoji ne porterait plus aucune information. On
  transpose donc l'**intention**, pas la valeur : gyrophare au dernier jour utile seulement (`T+1`).
- **Preheader** masqué portant l'échéance : c'est lui qui rend le mail utile depuis la liste des
  messages, sans l'ouvrir.
- **Ni blanc ni noir purs**, pour rester lisible quand un client inverse les couleurs.
- Le poids du bouton suit l'urgence : `ton: "secondaire"` sur la confirmation, un bouton plein sur
  un message disant « rien à faire » invitant à cliquer sans raison.

`node scripts/apercu-mail.ts` rend les onze variantes dans `apercu/`, avec un index qui les compare
à 375 px et 600 px. Un aperçu navigateur valide la mise en page, **pas** la compatibilité :
`scripts/tester-mail.ts` envoie un vrai gabarit pour relecture dans un client réel.

**Lien de connexion** : le mail pointe vers `/connexion/verifier`, une page qui **ne consomme
rien** au chargement et propose un bouton. Les passerelles de sécurité des messageries (Outlook Safe
Links, Proofpoint) suivent les liens des mails pour les inspecter : un jeton à usage unique brûlé
par un simple `GET` le serait par un robot avant même que le parent ne clique, et celui-ci lirait
« lien invalide » sans comprendre. `/api/auth/verifier` subsiste et redirige vers cette page, pour
les mails déjà partis. Même raisonnement que pour le désabonnement ci-dessous.

**Mise en pause** : lien signé HMAC (`lib/auth/pause.ts`), même modèle que le désabonnement, à deux
différences près. Le préfixe du message signé est `pause:` et non `desabonnement:` — sans quoi un
jeton vaudrait pour l'autre action, et les deux liens partent dans le même mail. Et **la semaine
visée fait partie de la charge signée** : un lien d'un mail de la semaine dernière est rejeté au lieu
de faire taire la semaine en cours, que le parent n'a jamais examinée.

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
