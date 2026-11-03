# Le portail exige un code 2FA : ne plus le prendre pour un refus

## Constat (2026-11-03)

Depuis le 2026-10-08, le service ne se connecte plus. Après le mot de passe, le SSO
(`connect1.3douest.com`) ne délivre plus de JWT : il répond `200` avec une page
« Vérification 2FA par email » — un code à 6 chiffres envoyé à l'adresse du compte, valable
60 minutes, et une case `remember_device` (« mémoriser cet appareil 30 jours »). Formulaire :
`_token`, `email_2fa_code`, `remember_device=1`, posté sur `/connexion`.

Les journaux publics du filet en gardent la trace :

| période | `/api/cron` |
|---|---|
| jusqu'au 07/10 | normal |
| 08/10 → 18/10 | `echec_technique`, nature `structure`, deux succès isolés (13 et 14/10) |
| 20/10 | `identifiants_invalides`, une seule fois |
| 21/10 → | `total: 0` — le compte est désactivé, plus personne n'est interrogé |

Trois défauts se sont enchaînés, et c'est leur combinaison qui a rendu la panne silencieuse.

1. **Une page inconnue au saut 3 est classée en refus d'identifiants.** Sans JWT, sans
   message du portail et sans statut d'erreur, `login()` lève `ErreurIdentifiants`. La page
   2FA tombe exactement là.
2. **La désactivation compte tous les échecs, pas les refus.** `echecs_consecutifs` cumule
   pannes et refus ; les erreurs de structure l'avaient porté à 3, et le premier refus a
   désactivé le compte. La règle voulue est « trois refus d'identifiants ».
3. **Le mail de désactivation n'est jamais parti.** `alerter()` sort dès que
   `alerte_echec_le` est posé — il l'avait été par l'alerte technique du 14/10. Le parent a
   été prévenu d'une panne passagère, jamais de la coupure de son compte.

## Ce que fait cette branche

- **Page 2FA reconnue explicitement** (`email_2fa_code` dans la chaîne suivie) →
  `ErreurStructure` au message explicite. Structurel parce que c'est bien le flux qui a
  changé : jamais rejoué (chaque tentative enverrait un code de plus au parent), signalé à
  Sentry en `error`, et ne désactive aucun compte.
- **Toute page 2xx sans message du portail** → `ErreurStructure`, avec le titre de la page
  dans le message. Le refus d'identifiants exige désormais un message du portail. Le cas
  documenté « `302` au corps vide » reste un refus. Sens de l'asymétrie : une vraie
  erreur d'identifiants mal reconnue donne une alerte technique en trop, bénigne ; l'inverse
  coupe un compte valide en silence.
- **Compteur de refus distinct** : colonne `refus_consecutifs` (migration `0004`),
  incrémentée sur `ErreurIdentifiants` seule, remise à zéro à la première réussite comme à
  l'enregistrement des identifiants. `echecs_consecutifs` garde son rôle pour la supervision
  (`echecsConsecutifs` mesure l'obstination de la panne, quelle qu'elle soit).
- **La désactivation alerte toujours**, même si une alerte de la série est déjà partie.
  Elle ne survient qu'une fois : le compte n'est plus sélectionné ensuite.

## Hors de cette branche

- **Rétablir le service** malgré le 2FA. Piste privilégiée : l'appareil de confiance — le
  parent saisit une fois le code dans l'app, on soumet `remember_device=1` et l'on conserve
  le cookie obtenu, chiffré, pour 30 jours. À valider par une expérience : la confiance
  est-elle liée au seul cookie, ou aussi à l'IP (qui change sur Vercel) ?
- **`total` qui tombe à 0** ne déclenche aucun signal. Une famille désactivée sort de la
  liste, et si c'est la dernière, le cycle n'a plus rien à dire.
- **Le filet de 19 h UTC part en pratique entre 21 h et 1 h 30 UTC**, souvent après minuit
  à Paris le lundi, c'est-à-dire après l'échéance qu'il devait rattraper.
