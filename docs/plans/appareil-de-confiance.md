# Appareil de confiance : se reconnecter malgré le code 2FA

> Révision 3 (2026-11-06) — PR A livrée (#9, #10), compte administrateur associé en prod ;
> la PR B est scindée, cf. « Livraison ». Révision 2 (2026-11-04) : questions tranchées. Fait suite à
> `docs/plans/portail-2fa.md` (PR #7), qui empêche la 2FA de couper les comptes mais ne
> rétablit pas la connexion.

## Contexte

Depuis le 2026-10-08, le SSO 3D Ouest exige un code à 6 chiffres envoyé par mail après le mot de
passe. Le service, qui se connecte sans personne devant l'écran, ne peut plus le faire seul :
**aucun rappel n'est parti depuis le 2026-10-21**. Et `enregistrerIdentifiants` éprouve les
identifiants par une connexion complète : **un nouveau parent ne peut même plus s'inscrire**.

## Ce qui a été observé (2026-11-03, `scratchpad/essai-2fa.mjs`)

| Fait | Conséquence pour le plan |
|---|---|
| Page « Vérification 2FA par email », formulaire `_token`, `email_2fa_code`, `remember_device=1`, posté sur `/connexion` | La soumission du code est un POST Laravel ordinaire, comme celle du mot de passe |
| Code accepté → page « Connexion effectuée » portant le JWT `3douest-auth-server` | La suite (`/api/login`, Bearer) est **inchangée** |
| Cookie `_email_2fa_device`, `connect1.3douest.com`, `HttpOnly`, `Max-Age=2591999` (30 j) | C'est lui, l'appareil de confiance |
| **Session neuve + ce seul cookie → connexion sans code**, sans mail envoyé | La piste tient, au moins depuis une même IP |
| Le cookie n'est **pas** réémis à la connexion suivante | Expiration fixe : un code à ressaisir **tous les 30 jours**, quoi qu'on fasse |
| Code reçu **~15 min** après la demande ; valable 60 min | Le parcours doit supporter une longue attente entre deux requêtes |
| `laravel-session` : `Max-Age=7200` | Une connexion entamée survit 2 h côté portail |
| **2026-11-04 : même cookie, autre opérateur** (box fixe → partage 4G), connexion sans code | La confiance n'est pas liée à l'IP, du moins pas entre réseaux grand public |

**Liaison à l'IP : écartée entre deux réseaux grand public (étape 0a), reste à confirmer depuis
Vercel.** Une IP de centre de données peut être traitée autrement qu'une IP mobile ; l'étape 0b
le tranche.

## Décisions structurantes

| # | Décision |
|---|---|
| 1 | **Valider l'IP d'abord** (étape 0), par un outil CLI contre la base de prod, avant toute UI. |
| 2 | **Le cookie se stocke chiffré comme le mot de passe** — AES-256-GCM, AAD = `parent_id` — avec sa date d'expiration lue dans `Max-Age`. |
| 3 | **Sans appareil valide, on n'appelle PAS le portail.** Chaque connexion sans cookie envoie un code au parent : un cron quotidien lui en enverrait un par jour. |
| 4 | **Un appareil rejeté est effacé** (cookie présent, non expiré, et pourtant page 2FA). Une seule tentative, donc un seul code parasite, puis silence côté portail. |
| 5 | **Nouvelle erreur `ErreurDoubleFacteur`**, ni refus ni panne : elle ne touche pas `refus_consecutifs` et ne désactive jamais. |
| 6 | **L'association fusionne avec l'enregistrement des identifiants.** Enregistrer le mot de passe déclenche l'envoi du code ; les identifiants ne sont tenus pour valides qu'une fois le code accepté. |
| 7 | **La connexion entamée est conservée en base**, chiffrée, 55 min. Le serverless ne garde rien entre la demande de code et sa saisie, et le code peut mettre un quart d'heure à arriver. |
| 8 | **Le pot à cookies devient par hôte.** Aujourd'hui il envoie tout à tout le monde : le cookie de confiance partirait vers `gestion.logiciel-enfance.fr`. |
| 9 | **Rappel d'expiration à J-5 et J-1**, par l'anti-doublon existant (`envois`), envoyé au **seul titulaire du compte** (`parents.email`) : c'est lui qui peut réassocier depuis les réglages, les autres destinataires n'y peuvent rien. |

## Le modèle

### Trois états d'appareil, et ce que fait le cron dans chacun

```
appareil absent ou expiré      → pas d'appel au portail ; statut `appareil_a_associer` ;
                                 un mail au parent par série (alerte_echec_le)
appareil valide                → connexion normale, cookie injecté avant le saut 3
appareil valide MAIS page 2FA  → `ErreurDoubleFacteur(rejete: true)` ; cookie effacé ;
                                 mail au parent ; signal Sentry `appareil-rejete` (error)
```

Le troisième cas est celui qui dénoncerait une confiance liée à l'IP. Il doit se voir **dès sa
première occurrence**, d'où `error` et non `warning` : s'il se produit pour une famille qui vient
d'associer son appareil, la piste entière est à revoir.

⚠️ **Ne pas filtrer l'état d'appareil en SQL.** Une famille sans appareil doit rester dans la
liste, pour compter dans `/api/cron` (`parStatut.appareil_a_associer`) et recevoir son mail. Une
famille qui disparaît de la liste, c'est exactement le `total: 0` qui a rendu la panne d'octobre
invisible.

### L'association en deux temps

```
[Envoyer le code]   sauts 1-3 avec le mot de passe
                    ├─ JWT direct        → le portail n'exige pas de 2FA : on enregistre, fini
                    ├─ page 2FA          → on conserve { pot à cookies, _token de la page 2FA }
                    │                      chiffré, expiration +55 min ; l'UI attend le code
                    └─ refus / panne     → comme aujourd'hui
[Valider le code]   on recharge la connexion entamée, POST _token + code + remember_device=1
                    ├─ JWT               → on extrait `_email_2fa_device` + Max-Age, on finit
                    │                      par /api/login et une lecture des prestations
                    │                      (la preuve complète que donne enregistrerIdentifiants)
                    ├─ page 2FA + message → code refusé : on garde la connexion, nouveau _token
                    └─ connexion expirée → « Demandez un nouveau code »
```

Le mot de passe saisi n'est enregistré qu'à la validation du code. Entre les deux temps, il vit
dans la connexion entamée, chiffré : un parent qui abandonne ne laisse pas d'identifiants à
moitié validés.

**Plafond** : une demande de code par parent toutes les 2 minutes. Chaque demande est une
connexion complète (throttling par IP) et un mail dans la boîte du parent.

## Travaux

### 0. Validation de l'IP

**0a — test éclair, sans rien construire.** Rejouer la reconnexion de l'essai (cookie conservé
dans le scratchpad) depuis une autre IP : le poste passé sur le partage de connexion d'un
téléphone, donc un autre opérateur. Une minute, aucun code envoyé si ça passe, un seul sinon.
Un échec tranche la question sans une ligne de code ; une réussite ne la tranche qu'à moitié —
une IP de centre de données peut être traitée autrement qu'une IP mobile — d'où 0b.
**Fait le 2026-11-04 : réussi.** Le cookie n'a de nouveau pas été réémis.

**0b — `scripts/associer.ts`, depuis Vercel.**

Outil CLI qui fait l'association complète depuis le poste de l'administrateur (attente du code
sur l'entrée standard ou dans un fichier) et écrit le cookie chiffré dans la base désignée par
`DATABASE_URL`. Joué une fois contre la prod pour le compte de l'administrateur : le cron Vercel du
lendemain se connecte depuis une **autre IP**.

- Connexion réussie → la piste tient, on construit la suite.
- `appareil-rejete` → la confiance est liée à l'IP : arrêt, et l'on rouvre l'alternative (transfert
  automatique des mails de code, cf. Risques).

L'outil reste utile ensuite : c'est le moyen de réassocier un compte sans passer par l'UI.

Prérequis côté code : étapes 1 à 3 ci-dessous, sans l'UI, **plus le minimum de l'étape 4** :
le cycle doit déchiffrer l'appareil, l'injecter, ne pas appeler le portail sans lui et effacer un
appareil rejeté. Sans ce câblage le cron du lendemain ne lirait pas le cookie, et l'étape 0b ne
prouverait rien. Les mails et la relance d'expiration restent en PR B.

### 1. Session — `lib/portail/session.ts`

- Pot à cookies indexé par hôte (`Map<hote, Map<nom, valeur>>`), envoi limité à l'hôte d'origine.
  **Vérifié le 2026-11-04** : `scripts/verifier.ts` passe de bout en bout (sauts 1 à 4 puis
  prestations) avec le pot par hôte et l'appareil injecté.
- `exporter()` / `nouvelleSession({ pot })` pour sérialiser et recharger une connexion entamée :
  **reporté en PR B**, seul l'écran d'association en a besoin — `associer.ts` garde la connexion
  en mémoire.
- Conserver l'expiration des `Set-Cookie` (`Max-Age`, à défaut `expires`) : c'est elle qui donne
  la date du cookie de confiance.

### 2. Connexion — `lib/portail/auth.ts`

- `ErreurDoubleFacteur` (`rejete: boolean`), levée sur la page 2FA à la place de l'`ErreurStructure`
  de la PR #7. `rejete` vaut vrai si un cookie de confiance avait été injecté.
- `login(cfg, session)` injecte `cfg.appareil` (valeur du cookie) dans le pot de `connect1` avant
  le saut 3.
- `demanderCode(cfg)` → `{ etat: "connecte", bearer, appareil? } | { etat: "code_requis", attente }`.
- `validerCode(attente, code)` → `{ bearer, appareil: { valeur, expireLe } }`, ou
  `ErreurCodeRefuse` portant le message du portail, ou connexion expirée.
- Le refus d'un code se lit comme celui d'un mot de passe : formulaire re-rendu **et** message.
  Sans message, c'est une page inconnue (même règle que la PR #7).

### 3. Base — `drizzle/0005_appareil_de_confiance.sql`

Sur `identifiants_portail`, la table du secret :

| Colonne | Rôle |
|---|---|
| `appareil_chiffre text` | valeur de `_email_2fa_device`, chiffrée |
| `appareil_expire_le timestamptz` | lue dans `Max-Age` |

La connexion entamée vit finalement dans **sa propre table**, `associations_portail`
(`chiffree`, `demandee_le`, `expire_le` ; migration `0006`), et non dans deux colonnes de plus :
un parent qui s'inscrit n'a pas encore de ligne d'identifiants, dont le mot de passe est
`NOT NULL`, et il ne doit pas en avoir avant que le code soit accepté.

La page admin ne charge aucune de ces colonnes, comme `mdp_chiffre`.

### 4. Cycle — `lib/service/verification.ts`

- Appareil absent ou expiré → statut `appareil_a_associer` sans appel au portail ; mail
  `mailAppareilAAssocier` une fois par série.
- `ErreurDoubleFacteur(rejete)` → effacement du cookie, même mail, nature `appareil`.
- Relance d'expiration : `relanceAppareil(aujourdhui, expireLe)` (pure, testée) → `J-5`, `J-1` ou
  rien ; envoi dédoublonné par `envois` (`type = 'appareil'`, `semaine_visee` = date
  d'expiration, `jours_avant` = jours restants).
- `nature: "appareil"` dans `NatureEchec`, `parNature` et `parStatut` de `/api/cron`.

### 5. Supervision — `lib/supervision/`

- `ErreurDoubleFacteur` non rejetée : **ignorée** (`aIgnorer`). Un appareil qui expire au bout de
  30 jours est le fonctionnement normal, comme un mot de passe changé.
- Rejetée : signal `appareil-rejete`, `error`, empreinte fixe. C'est le détecteur de la liaison à
  l'IP, et plus tard d'un changement de règle du portail.
- Toutes les familles en `appareil_a_associer` : signal `appareils-tous-expires`, `warning`.

### 6. Réglages — `app/reglages/`, `lib/service/reglages.ts`

- La section « Identifiants » devient « Connexion au portail » : identifiant, mot de passe, puis
  « Envoyer le code », puis le champ du code.
- Le texte d'attente dit le délai : « Le code est envoyé par 3douest.com et peut mettre une
  quinzaine de minutes à arriver. Vous pouvez fermer cette page et revenir : la demande reste
  valable une heure. Pensez à vérifier vos courriers indésirables. »
- Résumé (`resume.ts`) : « associé jusqu'au 3 décembre » (`ok`), « à renouveler avant le
  3 décembre » sous 5 jours (`attention`), « à associer » (`attention`).
- `verifierMaintenant` : sans appareil valide, il ne se connecte pas (décision 3) et renvoie vers
  l'association.

### 7. Mails — `lib/mail/messages.ts`

- `mailAppareilAAssocier` : « Le portail demande désormais un code de vérification. Pour que les
  rappels reprennent, associez le service une fois depuis vos réglages. » Bouton vers les réglages.
- `mailAppareilExpire` (J-5, J-1) : « L'association expire le 3 décembre. »
- Deux variantes de plus dans `scripts/apercu-mail.ts`.

### 8. Page `/confidentialite`

Elle dit ce que l'on stocke. Ajouter le cookie de confiance : sa nature (il dispense du code sur
cet appareil), sa durée (30 jours), son chiffrement.

## Tests

- Session : un cookie de `connect1` ne part pas vers `gestion` ; export/rechargement à l'identique ;
  `Max-Age` lu.
- `login` : cookie injecté → JWT ; page 2FA sans cookie → `ErreurDoubleFacteur(rejete: false)` ;
  avec cookie → `rejete: true`.
- `validerCode` : JWT + cookie extrait avec son expiration ; code refusé (formulaire + message) ;
  page inconnue → `ErreurStructure`.
- `relanceAppareil` : bornes J-6, J-5, J-1, J-0, expiré, sous `test:tz`.
- `signauxDe` : rejeté → `appareil-rejete` ; expiré → rien.
- `resume.ts` : les trois états.
- Fixture : la page 2FA réelle, **anonymisée** (adresse, `_token`, checksum Livewire), dans
  `tests/fixtures/`.

## Livraison

1. PR #7 fusionnée.
2. PR A : étapes 1 à 3, câblage minimal du cycle et du signal `appareil-rejete`,
   `scripts/associer.ts`. Association du compte administrateur en prod, puis lecture du cron du
   lendemain. Sans appareil, le statut `appareil_a_associer` est compté mais aucun mail ne part
   encore.
3. Si la connexion passe : PR B, étapes 4 à 8, en deux temps.
   - **B1 — l'association depuis les réglages** : `exporter()`, `associations_portail`,
     `lib/service/association.ts`, la section « Connexion au portail », son résumé (associé
     jusqu'au…, à renouveler sous 5 jours, à associer, code attendu), la page
     `/confidentialite`, la purge quotidienne des demandes expirées.
   - **B2 — les mails** : `mailAppareilAAssocier`, relances J-5 / J-1 au titulaire,
     signal `appareils-tous-expires`.

   **État au 2026-11-06.** La clé de chiffrement de prod étant illisible sur Vercel (variable
   sensible), elle a été remplacée ; la prod ne comptait qu'un jeu d'identifiants, rechiffré par
   `associer.ts --mot-de-passe-env` (#10). Compte administrateur associé le 2026-11-06 à 10 h,
   appareil valable jusqu'au 2026-12-06. L'étape 0b — connexion depuis Vercel — attend le
   premier cron ou un « vérifier maintenant ».
4. Au déploiement de la PR B, chaque famille sans appareil reçoit **un** mail « associez le
   service ». Aujourd'hui, une seule famille est inscrite.

## Risques assumés

- **Liaison à l'IP** : c'est l'étape 0 qui la tranche. Alternative en cas d'échec : le parent pose
  une règle de transfert des mails de 3douest.com vers une adresse entrante du service, qui lit le
  code seul. Plus lourd, et l'on recevrait des codes d'accès des familles.
- **Friction mensuelle** : un code tous les 30 jours, sans échappatoire puisque le cookie n'est pas
  renouvelé. Les relances J-5 / J-1 en atténuent l'oubli, pas la corvée.
- **Le portail peut raccourcir la durée** ou lier la confiance au User-Agent. Le UA du service est
  fixe (`session.ts`) : ne pas le changer sans réassocier tout le monde.
- **Le cookie est un second facteur.** Avec le mot de passe, il ouvre le compte sans code. Même
  régime que `mdp_chiffre` : chiffré, jamais journalisé, jamais chargé par l'admin, jamais envoyé
  à Sentry.

## Questions tranchées (2026-11-04)

1. **Friction mensuelle acceptée** pour l'instant. Piste pour plus tard : une adresse entrante
   Brevo (webhook) qui reçoit le mail de code et le saisit seule. Ce serait la même mécanique que
   l'alternative à la liaison IP, donc à concevoir une seule fois si l'une ou l'autre s'impose.
2. **J-5 et J-1, au seul titulaire du compte** (décision 9).
3. **Étape 0b contre la prod depuis ce poste : accordé.** Il faut pour cela le `DATABASE_URL` et la
   `CANTINE_CLE_CHIFFREMENT` de prod — la seconde est indispensable, le cookie doit être chiffré
   avec la clé que le cron utilisera.
