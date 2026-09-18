# Surveillance par jour, périscolaire et mise en pause

> Révision 2 — réécrite après une session de grilling (25 décisions). La révision 1 est fausse sur
> treize points : la pause, la confirmation, la clé d'unicité et les exclusions ont tous changé de
> sens.

## Contexte

Le service n'alerte aujourd'hui que sur **une** prestation (`RepE`, la cantine), avec **une** règle
d'échéance (lundi minuit pour la semaine suivante) et **aucune** préférence par famille sur les jours
concernés. Trois usages réels en souffrent :

1. **Jours jamais pris.** Certaines familles récupèrent les enfants tous les mardis : l'absence de
   réservation est normale, mais le service alerte quand même. Le bruit récurrent décrédibilise
   l'alerte, qui n'a de valeur que si elle est rare.
2. **Absences ponctuelles.** Un parent qui prend les enfants exceptionnellement reçoit un rappel par
   jour de rappel configuré jusqu'à l'échéance. Il lui faut un moyen de dire « je sais, c'est voulu »
   sans toucher à ses réglages ni se désabonner.
3. **Périscolaire non couvert.** Le matin et le soir se réservent aussi, avec une règle différente
   (**veille minuit**), et s'oublient tout autant. Aujourd'hui rien ne les surveille.

Résultat visé : un mail par famille et par jour, couvrant cantine et périscolaire, ne signalant que
les jours où la famille attend réellement une réservation, et portant un bouton qui fait taire la
cantine jusqu'à la prochaine échéance.

## Décisions structurantes

| # | Décision |
|---|---|
| 1 | **Une grille unique jours × prestations**, au foyer. « Ignorer le mardi » = décocher mardi sur la ligne cantine. |
| 2 | **Fenêtre périscolaire codée en dur** `[T+1, T+2]`, non configurable — hypothèse assumée, cf. Risques. |
| 3 | **La pause ne couvre que la cantine.** Le périscolaire continue d'alerter sur son horizon de 2 jours. |
| 4 | **La confirmation couvre le périmètre réellement surveillé**, en deux lignes distinctes. |
| 5 | **`jours_avant` est redéfini** en « quand vous donner des nouvelles ». Liste vide = interrupteur général. |
| 6 | **`envois.type` porte le périmètre** : `rappel_cantine`, `rappel_periscolaire`, `confirmation`. |
| 7 | **`CANTINE_EXCLUSIONS` ne s'applique qu'à la cantine.** |
| 8 | **Ordre de sections fixe** cantine → périscolaire ; objet piloté par le périmètre le plus pressant. |
| 9 | **🚨 périscolaire à J-1 seulement** — transposer l'intention du seuil, pas sa valeur. |
| 10 | **Aucune annonce**, une seule PR. |

## Le modèle

### Trois surveillances, deux règles d'échéance

```ts
// lib/portail/types.ts
export type CleSurveillance = "cantine" | "matin" | "soir";
```

| Clé | Prestation (regex, env) | Échéance | Fenêtre le jour T |
|---|---|---|---|
| `cantine` | `CANTINE_PRESTATION` (`RepE\|Repas enfant`) | lundi minuit, semaine suivante | `[semaineVisee, semaineVisee+6]` |
| `matin` | `CANTINE_PRESTATION_MATIN` (`Gmat\|Garderie matin`) | veille minuit | `[T+1, T+2]` |
| `soir` | `CANTINE_PRESTATION_SOIR` (`Gsoir\|Garderie soir`) | veille minuit | `[T+1, T+2]` |

La fenêtre périscolaire découle de la règle : pour un jour `D`, la réservation ferme au minuit qui
ouvre `D`, donc le dernier jour utile est `D-1` et l'avant-dernier `D-2`. Vu depuis `T`, les jours
encore rattrapables sont exactement `T+1` (dernier jour) et `T+2` (préavis). Le cron étant quotidien,
chaque jour d'école est vu deux fois — le lundi par les passages du samedi et du dimanche.

### Quand chaque fenêtre est construite

C'est le point de vérité unique du service. Tout le reste en découle mécaniquement.

```
jours_avant vide                      → aucune fenetre, la famille est ignoree (interrupteur general)
fenetre cantine        construite ssi  restants ∈ jours_avant  ET  pause_semaine ≠ semaine visee
fenetre matin / soir   construite ssi  la surveillance a ≥ 1 jour coche
                                       ET  jourSemaine(T+1) ou jourSemaine(T+2) y figure
aucune fenetre construite             → on n'appelle PAS le portail
```

C'est pour ça que la pause n'a **aucune** condition ailleurs : une fenêtre cantine non construite, et
il n'y a ni manquants, ni réservés, ni section, ni confirmation cantine. Mettre cette règle dans
`decider()` et dans la composition du mail l'éparpillerait en trois conditions devant rester
d'accord entre elles.

### Une seule requête portail par famille et par jour

`getPrestations` accepte des bornes libres (`lib/portail/prestations.ts:44-51`) et **ne filtre rien
par prestation** : le payload renvoie déjà `Gmat`, `Gsoir`, `RepE` et `ACCu` sur toute la plage
demandée. Le périscolaire ne coûte donc **aucune requête supplémentaire**, à condition d'interroger
l'union des fenêtres puis d'analyser chacune séparément — le motif déjà écrit dans
`scripts/verifier.ts:114-137`, à remonter dans `lib/portail` pour que l'app et le CLI le partagent.

> ⚠️ Budget de session 45 s, 15 s par requête (`lib/portail/session.ts:15-26`). Le maintien d'**une
> seule** requête est ce qui garantit qu'on n'y touche pas.

### Stockage : chaque colonne a un défaut sûr

Le tableau vide n'a pas le même sens sûr selon la prestation. On reprend le raisonnement déjà
appliqué à `joursSilencieux` (`lib/db/schema.ts:79-87`) — **le défaut, c'est-à-dire la liste vide,
doit toujours valoir le comportement sûr.**

| Colonne | Sens | Vide / null = |
|---|---|---|
| `jours_sans_cantine integer[]` | jours de semaine **sans** cantine attendue (négatif) | alerter tous les jours ✅ |
| `jours_matin integer[]` | jours **avec** périscolaire matin attendu (positif) | ne rien surveiller ✅ |
| `jours_soir integer[]` | idem, soir (positif) | ne rien surveiller ✅ |
| `pause_semaine date` | lundi de la semaine visée mise en silence | pas de pause ✅ |

`jours_sans_cantine` énonce un fait sur la famille — « les jours où il n'y a pas cantine » — là où un
`_ignores` décrirait un mécanisme interne ; et la lecture négative saute aux yeux, ce qui est
l'intention.

**Numérotation : 0 = lundi**, comme `planning.jour_0` du portail et comme `lundiDe`. À ne pas
confondre avec `jours_avant`, qui compte les jours **avant l'échéance** (0 = lundi *dernier jour*,
6 = mardi). Deux référentiels opposés, d'où des noms nettement différents — et deux cartes séparées
dans l'UI.

### `jours_avant` devient l'interrupteur général

Le lien « Ne plus recevoir de rappels » pose `jours_avant = []` (`app/desabonnement/page.tsx:31`). Le
périscolaire se déclenchant indépendamment de `jours_avant`, une famille désabonnée aurait continué à
recevoir des mails de garderie : **le lien aurait menti.**

`jours_avant` est donc redéfini en « quand voulez-vous m'entendre », et sa liste vide signifie
« jamais », toutes surveillances confondues. Les jours de périscolaire restent intacts pour un
éventuel retour. Aucune colonne nouvelle, aucun réglage perdu, et l'écran affiche déjà le bon
message (« Rappels desactives : aucun jour selectionne. »).

### La pause s'exprime en semaine visée

`pause_semaine = iso(semaineVisee)` : le cron compare à la semaine du jour. Quand l'échéance passe,
la semaine visée change, la valeur ne correspond plus et la cantine reprend **seule**. Pas
d'arithmétique de dates, pas de purge, recliquer est idempotent.

Elle éteint **rappel et confirmation** cantine : le parent a dit « pas de cantine cette semaine », lui
écrire « 12 repas réservés » deux jours plus tard serait encore lui parler de cantine. La confirmation
n'est pas une faveur, c'est le remède à une boîte vide inexpliquée — or ici, c'est lui qui l'a
demandée.

Conséquence : la pause **n'est plus filtrable en SQL**, puisqu'une famille en pause reste interrogée
pour son périscolaire.

### La clé d'unicité porte le périmètre

`envois(parent_id, semaine_visee, jours_avant, type)` désigne déjà un jour calendaire :
`semaine_visee = echeance + 7` et `jours_avant = echeance - T` déterminent `T` sans ambiguïté. Mais
avec deux périmètres et `type ∈ {rappel, confirmation}`, un rappel périscolaire posé à 16 h
occuperait la ligne `rappel` du jour : si une réservation de cantine était annulée entre-temps, le
filet de 19 h conclurait « déjà notifié » — **régression du filet existant**, étroite mais réelle, et
potentiellement le dernier jour utile.

`type` devient donc `rappel_cantine` | `rappel_periscolaire` | `confirmation`.

- Journée normale, les deux périmètres manquants : **un** mail, **deux** lignes posées.
- Rejeu du soir : les deux lignes existent, rien ne part.
- Nouveau problème sur l'autre périmètre à 19 h : sa ligne est libre, un second mail part — et il ne
  contient **que** la section non encore notifiée, sinon on renverrait ce qui est déjà parti.
- Le garde existant se généralise : pas de confirmation si **un** rappel, quel qu'il soit, est déjà
  parti aujourd'hui pour cette semaine.

⚠️ **Migration de données obligatoire** : `UPDATE envois SET type = 'rappel_cantine' WHERE type =
'rappel'`. Sans elle, les anciennes lignes n'entrent plus en collision et les familles reçoivent un
doublon le jour du déploiement.

## Travaux

### 1. `lib/portail` — dates et analyse multi-fenêtres

**`lib/portail/dates.ts`**
- `jourSemaine(d): number` → `(d.getUTCDay() + 6) % 7`, 0 = lundi.
- `JOURS_SEMAINE: string[]` et `JOURS_SEMAINE_UI = [0, 1, 2, 3, 4]` (lundi→vendredi).
- `fenetreVeille(aujourdhui): { debut, fin }` → `[T+1, T+2]`, avec le commentaire qui démontre la
  règle **et** signale qu'elle n'a pas été observée.
- `libelleJourAvant(n, { avecCantine })` : le suffixe « (dernier jour pour la cantine) » n'apparaît
  que si la famille surveille au moins un jour de cantine. Pour les autres, un jour nu — « lundi
  (dernier jour) » ne veut rien dire quand aucune échéance ne tombe ce lundi-là.

**`lib/portail/types.ts`**
- `CleSurveillance` ; `Cible` gagne `cle: CleSurveillance` (le libellé portail reste dans
  `prestation`).
- `ConfigPortail.prestation: RegExp` devient `motifs: Record<CleSurveillance, RegExp>`.

**`lib/portail/prestations.ts`** — le vrai morceau.
```ts
export type Fenetre = {
  cle: CleSurveillance;
  debut: Date;
  fin: Date;
  /** Jours de semaine ou la famille attend une reservation. 0 = lundi. */
  joursAttendus: ReadonlySet<number>;
  /** Dates absolues a ignorer. Cantine seule : une sortie scolaire supprime le
   *  repas, pas la garderie du matin. */
  exclusions: ReadonlySet<string>;
  /** La cantine est requise : son absence est une erreur de structure. */
  requise: boolean;
};

export function analyser(payload: Payload, cfg: ConfigPortail, fenetres: Fenetre[]): Analyse;
```
- Résolution des ids de prestation par fenêtre. Une prestation réclamée par **deux** motifs lève une
  `ErreurStructure` explicite : sans ça un pointage serait compté deux fois et la config fautive
  passerait inaperçue.
- `requise: false` + aucune prestation correspondante ⇒ fenêtre ignorée, clé remontée dans
  `Analyse.absentes: CleSurveillance[]`, **sans lever**. Un portail sans garderie ne doit pas casser
  le service pour tout le monde.
- Prédicat des manquants, en remplacement de `prestations.ts:158-161` :
  `!estReserve(pt) && !pt.disabled && !f.exclusions.has(pt.date) && f.joursAttendus.has(jourSemaine(...))`.
- `joursAttendus` et `exclusions` ne filtrent **que** les manquants, jamais `reserves` — même
  asymétrie qu'aujourd'hui : un repas réservé un jour non attendu reste un repas réservé.
- **Détection de fenêtre fausse** : tout pointage retenu en `ETAT_BLOCAGE_DEPASSE` remonte dans
  `Analyse.fenetresDepassees: CleSurveillance[]`. Le portail distingue `ETAT_PRESTATION_FERMEE` (jour
  non proposé — mercredi, vacances) de `ETAT_BLOCAGE_DEPASSE` (**échéance dépassée**) : ce second code
  sur un pointage de J+1 est la signature exacte de « notre fenêtre est trop tardive », impossible à
  confondre avec des vacances.
- `manquants`/`reserves` portent `cle` ; `rapportStructure` ventile par clé.

**`lib/portail/index.ts`**
- `verifierParent(cfg, { aujourdhui, fenetres, trace })` : `debut = min(fenetres.debut)`,
  `fin = max(fenetres.fin)`, **une** connexion, **une** requête, un seul `analyser`.
- `fenetresPour({ aujourdhui, joursAvant, restants, enPause, joursSansCantine, joursMatin, joursSoir,
  exclusions, semaines })` applique le tableau de décision ci-dessus et rend `[]` quand il n'y a rien
  à regarder — le signal « ne pas appeler le portail ».
- `configDepuisEnv` lit les trois motifs.

### 2. Base — `drizzle/0003_surveillance_et_pause.sql`

`lib/db/schema.ts`, table `rappels` : les quatre colonnes du tableau plus haut, commentées sur le
pourquoi du positif/négatif. Table `envois` : retirer le `default('rappel')` de `type`, qui n'a plus
de valeur juste (on l'écrit toujours explicitement).

`npm run db:generer`, puis **ajouter à la main** l'instruction de migration de données à la fin du
`.sql` généré :
```sql
UPDATE "envois" SET "type" = 'rappel_cantine' WHERE "type" = 'rappel';
```
Elle ne touche pas au schéma, donc le snapshot reste valide. Puis renommer — **trois** endroits à
aligner : le `.sql`, `drizzle/meta/0003_snapshot.json`, et le `tag` dans `drizzle/meta/_journal.json`.
Aucune table nouvelle, donc `scripts/migrer.ts:68-75` reste tel quel.

L'index GIN `rappels_jours_avant_idx` reste utile : le `WHERE` du cron continue de s'en servir.

### 3. Jeton de pause — `lib/auth/pause.ts`

Calqué sur `lib/auth/desabonnement.ts` (29 lignes, à lire avant d'écrire) :
`signerPause(parentId, semaineIso)` / `verifierPause(jeton): { parentId, semaine } | null` /
`urlPause(parentId, semaineIso)`.

- Préfixe HMAC **`pause:${parentId}:${semaine}`** — un préfixe différent de `desabonnement:` est ce
  qui empêche un jeton de valoir pour l'autre action.
- La semaine est dans la charge signée : un lien d'un mail de la semaine dernière ne peut pas mettre
  en pause la semaine en cours.
- `secretSignature()` et `egaliteConstante` réutilisés tels quels.

### 4. Décision — `lib/service/decision.ts`

Toujours pure, un paramètre de plus :
```ts
export function decider({
  manquants,        // tous perimetres verifies aujourd'hui
  reserves,         // idem — c'est ce qui preserve le garde vacances
  jourDeNouvelles,  // restants ∈ jours_avant
  joursRestants,
  joursSilencieux,
}): Decision {
  if (manquants > 0) return "rappel";
  // Un jour periscolaire seul n'a rien a confirmer : la confirmation parle de la
  // semaine visee, qu'on n'a meme pas regardee.
  if (!jourDeNouvelles) return "silence";
  if (reserves === 0) return "silence";
  return joursSilencieux.includes(joursRestants) ? "silence" : "confirmation";
}
```

### 5. Cycle de rappel — `lib/service/verification.ts`

**Sélection** (`verification.ts:134-152`) :
```sql
parents.actif
AND cardinality(rappels.jours_avant) > 0            -- interrupteur general
AND (rappels.jours_avant @> ARRAY[<restants>]::integer[]
     OR cardinality(rappels.jours_matin) > 0
     OR cardinality(rappels.jours_soir) > 0)
```
La pause **n'est plus** dans le `WHERE`. Projeter `joursSansCantine`, `joursMatin`, `joursSoir`,
`pauseSemaine`.

**Dans la boucle** : construire les fenêtres via `fenetresPour`.
- Fenêtres vides **et** pause active ⇒ statut `en_pause`, sans appeler le portail.
- Fenêtres vides pour toute autre raison ⇒ passer au parent suivant **sans le compter** dans
  `traites` : sinon le décompte par statut de `/api/cron` se remplit de non-événements.

**Envois** : composer d'abord, puis poser une ligne **par périmètre manquant**
(`rappel_cantine`, `rappel_periscolaire`) en `onConflictDoNothing().returning()`. Le mail expédié ne
contient que les sections dont l'insertion a rendu une ligne. Aucune ligne rendue ⇒ `deja_notifie`.
En cas d'échec d'expédition, **supprimer toutes les lignes posées à ce passage** — l'ordre
insertion-avant-envoi reste le verrou anti-doublon, et le laisser après un échec transformerait une
panne passagère en rappel définitivement perdu.

**Journaux** : `fenetresDepassees` et `absentes` remontent comme les états non répertoriés — trace du
cron et agrégat `/api/cron` (aucune adresse, les journaux GitHub Actions sont publics).

**Instrumentation de capacité** : une famille qui coche un jour de garderie passe de ~2 jours sur 7 à
7 jours sur 7. À 3 s de pause et 300 s de plafond, le service tient ~50 comptes, et le dépassement est
muet. Tracer en fin de cycle la **durée écoulée** et le **nombre de familles non traitées**, et les
remonter dans l'agrégat : ça transforme une panne silencieuse en signal avant qu'elle n'arrive.

### 6. Mails — `lib/mail/messages.ts`

```ts
mailRappel({ cantine, periscolaire, aujourdhui, liens }): Mail;
// cantine      : { manquants: Cible[]; semaine; echeance; joursRestants } | null
// periscolaire : Cible[] (cle "matin"/"soir", dates T+1 et T+2)

mailConfirmation({ cantine, periscolaire, liens }): Mail;
// cantine      : { semaine; echeance; reserves: number } | null
// periscolaire : { jours: Date[] } | null
```

- **Ordre fixe cantine → périscolaire.** L'encart de tête et l'objet portent déjà l'échéance la plus
  pressante ; l'ordre du corps ne joue donc plus sur l'urgence, seulement sur l'habitude de lecture.
  Un mail récurrent dont la structure bouge se lit moins vite.
- **Une échéance par section** : « avant lundi 21 septembre, minuit — dans 4 jours » pour la cantine,
  « avant ce soir minuit » (`T+1`) ou « avant demain soir, minuit » (`T+2`) pour le périscolaire.
- **`urgent`** reste « ce soir avant minuit » et devient vrai si la cantine est à J-0 **ou** si une
  cible périscolaire tombe à `T+1`. Les deux disent littéralement la même chose, la formulation reste
  donc vraie.
- **Gyrophare** : `SEUIL_PRESSE = 2` a été calibré sur un cycle de 7 jours, où « il reste 2 jours »
  est vraiment la dernière ligne droite. Sur un cycle de 2 jours le même seuil couvre tout le cycle et
  ne porte plus aucune information. On transpose donc l'**intention** : 🚨 périscolaire à **J-1
  seulement**, ⚠️ à J-2. Cantine inchangée.
- **Objet** : il épouse le périmètre le plus pressant et relègue l'autre en suffixe —
  `🚨 Dernier jour — périscolaire de jeudi · et 3 repas non réservés`. Un objet à parts égales
  rendrait « Dernier jour » faux pour l'un des deux. **Une famille sans périscolaire doit retrouver
  l'objet actuel au caractère près** : c'est le test de non-régression.
- **Confirmation en deux lignes distinctes**, chacune nommant sa période — « Semaine du 28 septembre :
  12 repas réservés. » / « Périscolaire : rien à réserver jeudi ni vendredi. » Une phrase globale
  affirmerait une couverture du périscolaire sur des jours jamais regardés.
- Nouveau helper `grouperPeriscolaire(cibles): GroupeJours[]` groupant par (enfant, jour) →
  `"jeudi 18 (matin)"`, `"vendredi 19 (matin et soir)"`, pour réutiliser le bloc existant
  `joursParEnfant` (`lib/mail/gabarit.ts:157`).
- **Bouton de pause** : `bouton({ libelle: "Pas de cantine cette semaine", url: liens.pause, ton:
  "secondaire" })`, affiché **uniquement** sur un rappel contenant une section cantine avec des
  manquants. Le libellé nomme ce qu'il coupe ; la page dira ce qu'il ne coupe pas.
- **Chaque bloc rend ses deux formats** (`type Bloc = { html; texte }`) et **tout ce qui vient du
  portail passe par `echapper()`** — prénoms et libellés de prestation compris.

`Liens` (`messages.ts:26-31`) gagne `pause?: string`, posé par `liensPour` (`verification.ts:39-43`).

### 7. Page de pause — `app/pause/page.tsx`

Calquée sur `app/desabonnement/page.tsx` (85 lignes, modèle exact) :

- **Page-bouton, jamais d'effet au chargement.** Outlook Safe Links et les antivirus suivent les
  liens des mails : une pause déclenchée par un `GET` serait posée par un robot à l'insu du parent.
  Règle de sécurité du dépôt, pas préférence de style.
- Le jeton est **revérifié dans la server action**, indépendamment du rendu — le formulaire est
  public.
- Jeton dont la semaine est révolue ⇒ « Ce lien concerne la semaine du X, déjà passée. Vos réglages
  n'ont pas été modifiés. »
- Succès ⇒ « Vous ne recevrez plus de rappel de cantine jusqu'au <mardi date>. **Vous continuerez à
  recevoir les alertes de périscolaire, qui se réservent la veille.** » Sans cette seconde phrase, le
  premier mail de garderie du lendemain passe pour un bug.

### 8. Réglages

**`lib/service/reglages.ts`**
- `Reglages` gagne `joursCantine: number[]` (rendu **en positif** pour l'écran, dérivé de
  `joursSansCantine`), `joursMatin`, `joursSoir`, `pauseSemaine: string | null`.
- `enregistrerSurveillance(parentId, { cantine, matin, soir })` : valide `0..6`, dédoublonne, trie,
  reconvertit la cantine en négatif — patron de `enregistrerRappels:131-146`.
- `mettreEnPause(parentId, semaineIso)` / `reprendreAlertes(parentId)`.
- `Apercu` gagne le détail périscolaire, `absentes`, `fenetresDepassees`, **et la liste des jours
  écartés par les réglages**.

**`app/reglages/`** — deux cartes distinctes, séparées par un titre : les deux tableaux comptent les
jours dans des référentiels opposés, les fusionner ferait apparaître deux fois le mot « lundi » avec
deux sens différents.

1. **« Ce que l'on surveille »** — `<form action={actionSurveillance}>` et un composant client
   `grille-surveillance.tsx` calqué sur `lignes-rappel.tsx` : cinq lignes lundi→vendredi, trois
   colonnes de cases (`name="cantine" | "matin" | "soir"`, relues par `formData.getAll`). Le style
   `.jours` de `app/globals.css:129-146` existe déjà et n'est utilisé nulle part.
   Mercredi reste affiché : c'est le portail qui le rend fermé, coder le calendrier d'une
   collectivité dans l'UI est ce que `CLAUDE.md` interdit.

   Texte d'aide — **seule porte d'entrée du périscolaire**, puisqu'il n'y a pas d'annonce :
   > Cochez les jours où vos enfants doivent être inscrits. **Cantine** : tout est coché par défaut —
   > décochez les jours où ils ne mangent jamais à la cantine, vous ne serez plus relancé pour ces
   > jours-là.
   > **Périscolaire du matin et du soir** : rien n'est coché par défaut. Ces inscriptions se réservent
   > **jusqu'à la veille à minuit** ; si vous cochez un jour, vous serez prévenu l'avant-veille puis
   > la veille en cas d'oubli.

   Avertir si la cantine n'a plus aucun jour coché, comme le fait déjà `actionRappels`.

2. **« Quand vous donner des nouvelles »** — la table actuelle, renommée (elle ne parle plus de la
   seule cantine).

3. **« Mettre en pause »** — état courant et bouton « Reprendre les alertes » / « Ne rien m'envoyer
   sur la cantine jusqu'à la prochaine échéance ».

**`app/admin/page.tsx`** : colonne « Pause » (`pause_semaine` ou `—`), `colSpan={6}` → `{7}` ligne 83.
Toujours **ni `mdp_chiffre` ni `portail_email`** dans la requête.

### 9. CLI, docs, aperçus

- **`scripts/verifier.ts`** : les **trois** surveillances, **tous** les jours attendus, aucune
  exclusion. Un outil de diagnostic montre l'état du portail, il ne simule pas une préférence — et
  c'est ce qui en fait le moyen de vérifier que `Gmat` à J+1 revient bien réservable. Il passe par
  `fenetresPour` comme le cron : `CLAUDE.md` interdit une seconde implémentation de la règle.
- **`scripts/apercu-mail.ts`** : ajouter `rappel-periscolaire`, `rappel-mixte`,
  `confirmation-mixte` aux 8 variantes.
- **`scripts/seed.ts`** : options `--sans-cantine`, `--matin`, `--soir`, `--pause`.
- **`.env.example` + tableau du README** : `CANTINE_PRESTATION_MATIN`, `CANTINE_PRESTATION_SOIR`.
- **`app/confidentialite/page.tsx:20-26`** : ajouter les nouveaux réglages aux données conservées.
- **`CLAUDE.md`** : §4 devient « deux règles d'échéance » ; l'avertissement « les prestations n'ont
  pas le même délai » devient la description du modèle de fenêtres ; documenter le positif/négatif
  des colonnes, `jours_avant` comme interrupteur général, le périmètre dans `envois.type`, et le
  fait que la fenêtre périscolaire est une **hypothèse non observée**.

### 10. Tests (`node --test`, `node:assert/strict`, aucune dépendance)

- `tests/dates.test.ts` — `jourSemaine`, `fenetreVeille`, `libelleJourAvant` conditionnel ; tourne
  sous 4 fuseaux via `npm run test:tz`.
- `tests/decision.test.ts` — la branche `jourDeNouvelles: false` (périscolaire seul ⇒ jamais de
  confirmation).
- `tests/prestations.test.ts` — la fixture contient **déjà** `13 → Gmat / "Garderie matin"`, et le
  test `:168-185` qui affirme que la garderie est hors périmètre **change de sens**. Ajouter :
  filtrage par `joursAttendus`, exclusions cantine n'atteignant pas la garderie, fenêtres disjointes
  sur un même payload, motifs qui se chevauchent ⇒ `ErreurStructure`, prestation non requise absente
  ⇒ `absentes`, `ETAT_BLOCAGE_DEPASSE` ⇒ `fenetresDepassees`.
- `tests/fenetres.test.ts` — le tableau de décision de construction des fenêtres, ligne par ligne :
  c'est le point de vérité unique du service, il mérite son fichier.
- `tests/pause.test.ts` — jeton signé, jeton d'une autre semaine, jeton de désabonnement rejeté
  (calqué sur `tests/desabonnement.test.ts`).
- `tests/messages.test.ts` — les formes d'objet, **non-régression de l'objet cantine seul**, les deux
  lignes de la confirmation, parité HTML/texte, échappement des prénoms.

## Vérification

```bash
npm run typecheck && npm test && npm run test:tz    # a chaque etape, tout est pur
docker compose up -d db && npm run db:migrer
node scripts/seed.ts --rappels 0,1,4 --sans-cantine 1 --matin 0,3 --soir 3
node scripts/verifier.ts --verbose                  # les deux regles cote a cote, portail reel
node scripts/apercu-mail.ts && open apercu/index.html
node scripts/cron.ts --verbose
```

**Le contrôle qui compte, sur le portail réel** — la fenêtre périscolaire étant codée en dur sans
avoir été observée, `scripts/verifier.ts` sert à la confronter : les pointages `Gmat`/`Gsoir` de J+1
et J+2 doivent revenir `disabled: false` et `ETAT_NON_RESERVE`. S'ils reviennent en
`ETAT_BLOCAGE_DEPASSE`, la fenêtre est trop tardive et `fenetresDepassees` le dira aussi en
production.

**Les cas à exercer à la main** (`docker exec cantine-db psql -U cantine -d cantine -c "DELETE FROM
envois;"` entre deux essais — sinon l'anti-doublon rend `deja_notifie`) :

1. Jour de nouvelles **et** périscolaire manquant ⇒ un seul mail, deux sections, **deux** lignes
   `envois`.
2. Périscolaire manquant un jour **sans** nouvelles ⇒ mail périscolaire seul, aucune confirmation.
3. Rejouer le même jour ⇒ `deja_notifie`, aucun second mail.
4. Poser `rappel_cantine` à la main, puis lancer un cycle où le périscolaire manque ⇒ un mail
   **périscolaire seul**, sans la section cantine déjà notifiée.
5. Mardi décoché côté cantine, mardi non réservé ⇒ aucun rappel ; « vérifier maintenant » le liste
   quand même comme écarté par les réglages.
6. Pause active ⇒ plus aucun message de cantine, rappel comme confirmation ; le périscolaire continue
   de partir. Après l'échéance, reprise automatique.
7. `jours_avant = []` ⇒ **aucun** mail, même avec des jours de garderie cochés.
8. Rien à faire aujourd'hui (pas de nouvelles, pas de jour de garderie à J+1/J+2) ⇒ **aucune
   connexion au portail**, visible avec `--verbose`.
9. Une famille sans périscolaire ⇒ objet et corps identiques à aujourd'hui.

**Enfin, en réel** : `node scripts/tester-mail.ts moi@exemple.fr` — un aperçu navigateur valide la
mise en page, pas la compatibilité Outlook/Gmail.

## Livraison

Mémoire projet : **livrer par pull request, pas de commit direct sur `main`.**

Une branche, une PR, commits par couche dans l'ordre ci-dessus (portail → base → service → mails →
pause → UI → docs), chacun laissant `typecheck` + `test` verts. C'est le découpage en commits qui
rendra une PR de cette taille relisible.

## Risques assumés

**La fenêtre périscolaire est codée en dur sans avoir été observée.** La détection
`ETAT_BLOCAGE_DEPASSE` rattrape le cas « notre fenêtre est trop tardive ». Elle ne rattrape **pas** le
cas inverse : si la garderie n'ouvre à la réservation que plus tard, les pointages reviendront en
`ETAT_PRESTATION_FERMEE`, indistinguable de vacances, et le service restera muet sans le dire. Le
contrôle manuel ci-dessus est le seul filet sur cet angle mort.

**La fonctionnalité part éteinte et sans annonce.** L'adoption dépend entièrement du texte de la carte
« Ce que l'on surveille » : une famille ne découvrira le périscolaire qu'en ouvrant ses réglages.

**Par foyer, pas par enfant.** Si un enfant mange le mardi et pas l'autre, il faudra garder le mardi
coché et accepter le rappel. Passer par enfant demanderait de propager `fkindividu` dans `Cible`
(absent aujourd'hui, `lib/portail/types.ts:33-38`) et de lister les enfants dans l'UI.

**Deux états de la légende du portail restent non observés** (« Pré-réservé », « En attente et
bloqué »). Le périscolaire multiplie les pointages lus, donc les chances de les croiser. Ne **jamais**
ajouter « Pré-réservé » à `ETATS_RESERVES`.
