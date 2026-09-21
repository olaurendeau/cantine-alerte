# Supervision par Sentry

## Contexte

Le service a deux modes d'échec, et un seul se voit aujourd'hui.

Le premier est bruyant : une exception remonte, Vercel la consigne, la page renvoie une erreur. On
finit par la trouver — à condition d'aller regarder.

Le second est **silencieux**, et c'est le seul qui coûte un repas :

- le cron n'a pas tourné du tout — rien dans les journaux, puisqu'il n'y a pas eu d'exécution ;
- `nonTraites > 0` — des familles n'ont pas été examinées, leur rappel du jour est perdu ;
- `ErreurStructure` — le portail a changé son HTML, le parsing casse, le service se tait ;
- `fenetresDepassees` — la règle « veille minuit » du périscolaire, **déduite et jamais observée**,
  serait fausse : on interroge des jours déjà verrouillés et l'alerte n'arrive jamais.

Ces quatre signaux existent déjà dans le code. Ils atterrissent dans `console.log` et dans la
réponse de `/api/cron`, c'est-à-dire dans deux endroits que personne ne consulte un mardi soir.
Sentry sert à les faire **venir à nous**.

## Décisions

| # | Décision |
|---|---|
| 1 | **Le check-in de cron est la pièce maîtresse.** C'est le seul dispositif qui détecte une exécution qui n'a pas eu lieu. |
| 2 | **`tunnelRoute` plutôt qu'élargir la CSP.** Les événements navigateur transitent par notre propre origine, `connect-src 'self'` reste inchangé. |
| 3 | **Pas de Session Replay.** Il filmerait l'écran du parent, prénoms d'enfants compris. |
| 4 | **`parent_id` seul**, jamais d'adresse ni de prénom. Les query strings sont supprimées avant envoi. |
| 5 | **Sentry ne rentre pas dans `lib/`.** C'est de l'infrastructure de plateforme : elle vit dans `app/` et dans les fichiers `instrumentation*`. |
| 6 | **Filtrage agressif à la source.** `ErreurIdentifiants` et les `429` ne partent jamais : une alerte qu'on apprend à ignorer ne sert plus à rien. |
| 7 | **Pas de DSN, pas de SDK.** Le service tourne à l'identique sans Sentry, en local comme en Docker. |

## Ce qui part, et ce qui ne part pas

L'asymétrie du service — « une alerte en trop est bénigne, une alerte manquante fait rater le
repas » — **ne se transpose pas** à la supervision. Ici c'est l'inverse : une alerte de trop, répétée,
apprend à ne plus lire les alertes, et la vraie panne passe avec les autres.

| Situation | Sentry | Pourquoi |
|---|---|---|
| Cron non exécuté | **check-in `missed`** | Le pire échec, et le seul invisible partout ailleurs. |
| `nonTraites > 0` | **error** | Des familles non examinées ; leur rappel est perdu. |
| `fenetresDepassees` | **error** | Dénonce la règle périscolaire déduite. Le signal que le plan de phase 3 attendait. |
| `ErreurStructure` | **error** | Le portail a changé : le parsing est à reprendre, le service est cassé. |
| Cycle interrompu | **error** | Base injoignable, secret manquant — le cadre lui-même a lâché. |
| `surveillancesAbsentes` | **warning** | Une prestation surveillée n'existe pas : silence invisible. |
| `etatsNonRepertories` | **warning** | Nouvel état à classer (« Pré-réservé », « En attente et bloqué »). |
| `echec_envoi` | **warning** | Le verrou est libéré, le rejeu du soir retentera. |
| `ErreurTemporaire` 5xx | **warning**, agrégé | Panne passagère du portail. Une par famille serait du bruit. |
| `ErreurTemporaire` 429 | **rien** | Throttling attendu, que le service évite déjà par construction. |
| `ErreurIdentifiants` | **rien** | Le parent a changé son mot de passe. Le service le désactive et lui écrit : c'est le fonctionnement normal. |

⚠️ **`statut` seul ne suffit pas à trancher.** `ErreurStructure` et `ErreurTemporaire` tombent toutes
deux en `echec_technique`. D'où l'ajout d'un champ `nature` sur `ResultatParent` — une donnée, pas un
appel à Sentry : `lib/` reste ignorant de la plateforme.

## Données

⚠️ **Des jetons vifs circulent en query string** : `/connexion/verifier?token=`, `/pause?jeton=`,
`/desabonnement?jeton=`. Sentry capture les URL par défaut. Sans filtrage, une erreur sur ces routes
expédierait un jeton de session **valide** chez un tiers.

`lib/supervision/anonymiser.ts` — pur, testé, sans import Sentry — applique trois règles :

1. **Query string supprimée** de toute URL, partout (événement, requête, fil d'Ariane).
2. **Adresses mail masquées** dans les messages et les valeurs d'exception : les motifs d'erreur
   viennent du portail et de Brevo, qui les citent volontiers.
3. **`sendDefaultPii: false`** et surtout **jamais `includeLocalVariables`** : le mot de passe du
   portail est déchiffré en mémoire pendant le cycle, il se retrouverait dans la pile.

Une famille n'est identifiée que par son UUID : `Sentry.setUser({ id })` sur les actions
authentifiées, `parentIds` dans le contexte des signaux du cycle. Pseudonyme, donc suffisant pour
répondre à « une famille ou toutes ? » sans qu'une adresse ou un prénom d'enfant ne quitte le
service. `nettoyerEvenement` réduit de toute façon `user` à son seul `id`, y compris l'IP que le SDK
ajoute de lui-même.

⚠️ **`/confidentialite` affirme « Aucune donnée n'est transmise à un tiers ».** La page doit dire ce
qui part désormais, sous peine de promettre ce que le code ne tient plus.

## Travaux

1. `@sentry/nextjs` en dépendance, région EU.
2. `lib/supervision/` : `anonymiser.ts` (nettoyage), `filtres.ts` (ce qu'on ignore),
   `signaux.ts` (la taxonomie d'alerte) — tous purs, tous testés.
3. `instrumentation.ts`, `instrumentation-client.ts`, `sentry.{server,edge}.config.ts`.
4. `next.config.ts` : `withSentryConfig`, `tunnelRoute`, commentaire sur la CSP préservée.
5. `lib/service/verification.ts` : champ `nature` sur `ResultatParent`.
6. `app/api/cron/supervision.ts` : check-in `in_progress` / `ok` / `error`, envoi des signaux,
   `flush()` avant la réponse. Le filet GitHub passe `?filet=1` et ne pointe pas.
7. `.env.example`, `README.md`, `CLAUDE.md`, `app/confidentialite/page.tsx`.

## Vérification

- `npm test`, `npm run test:tz`, `npm run typecheck`.
- **Build Docker sans aucune variable Sentry** : c'est le cas qui casse le plus facilement, et c'est
  celui que rencontre un contributeur.
- CSP relevée sur une page servie : `connect-src` doit toujours valoir `'self'`.
- Réécriture `/supervision` présente dans la config résolue **avec** un DSN — sans elle, la promesse
  sur la CSP serait fausse en production, et seule la production s'en apercevrait.

## Risques assumés

**Le filet ne pointe pas, et c'est ce qui sauve le dispositif.** Les deux appelants partagent
l'endpoint : si le passage GitHub de 19 h envoyait son propre check-in, il refermerait l'alerte du
cron Vercel de 16 h, et la mort de celui-ci resterait invisible tant que le filet tient. D'où
`?filet=1`, qui le rend muet côté Sentry. On obtient alors la bonne sémantique : les rappels partent
quand même **et** l'alerte « le cron Vercel n'a pas tourné » se lève. Le `checkinMargin` de 60 min
est calé sur 16 h — le plan Hobby déclenche à ±59 minutes.

**Sentry est un tiers de plus dans la chaîne.** Un DSN absent ou invalide ne doit jamais empêcher un
rappel de partir : toute la supervision est en `try`/`catch`, et l'échec d'un envoi Sentry n'est
jamais propagé.
