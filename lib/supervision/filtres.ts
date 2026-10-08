/**
 * Ce qui ne doit jamais remonter dans Sentry.
 *
 * L'asymetrie du service — « une alerte en trop est benigne, une alerte
 * manquante fait rater le repas » — NE se transpose PAS a la supervision. Ici
 * c'est l'inverse : une alerte de trop, repetee tous les jours, apprend a ne
 * plus lire les alertes, et la vraie panne passe au milieu des autres.
 *
 * Pur et sans import du SDK, comme `anonymiser.ts` : la CI n'a ni reseau ni
 * secret. Le tri se fait sur `error.name` et non sur `instanceof` pour que ce
 * module n'ait pas a connaitre `lib/portail` — les trois classes posent leur
 * `name` dans leur constructeur.
 */

/** Le statut HTTP porte par une ErreurTemporaire, quand il y en a un. */
function statutDe(erreur: Error): number | undefined {
  const statut = (erreur as Error & { statut?: unknown }).statut;
  return typeof statut === "number" ? statut : undefined;
}

/**
 * Vrai si l'erreur releve du fonctionnement normal du service.
 *
 * Les deux cas sont des evenements attendus, pas des pannes :
 *
 * - **identifiants refuses** : le parent a change son mot de passe sur le
 *   portail. Le service desactive le compte et lui ecrit — c'est exactement ce
 *   qu'il doit faire. En faire une alerte, c'est une notification par famille
 *   distraite ;
 * - **429** : le portail limite le debit par adresse IP. Le service l'evite
 *   deja par construction (`CANTINE_PAUSE_MS`, aucun reessai sur 429), et s'en
 *   alarmer n'ajoute rien — insister est precisement ce qu'il ne faut pas
 *   faire.
 *
 * Une `ErreurTemporaire` en 5xx, elle, passe : le portail est en panne, et si
 * ca dure les rappels tombent.
 */
export function aIgnorer(erreur: unknown): boolean {
  if (!(erreur instanceof Error)) return false;
  if (erreur.name === "ErreurIdentifiants") return true;
  if (erreur.name === "ErreurTemporaire" && statutDe(erreur) === 429) return true;
  return false;
}

/**
 * Les natures d'echec que le cycle sait distinguer, cf. `ResultatParent`.
 *
 * ⚠️ `cycle` et `inconnue` ne sont pas synonymes, et les confondre a deja
 * induit en erreur : `inconnue` sort du `catch` de `traiterParent`, qui a donc
 * appele `alerter()` — le parent a recu son mail d'echec technique. `cycle`
 * sort du filet de derniere instance d'`executerCron`, qui court-circuite
 * `alerter()` : la famille n'a RIEN recu. Le diagnostic n'est pas le meme.
 */
export type NatureEchec = "identifiants" | "temporaire" | "structure" | "inconnue" | "cycle";

/**
 * La nature d'une erreur, telle que le cycle la consigne.
 *
 * ⚠️ `statut` seul ne suffit pas a trancher : `ErreurStructure` et
 * `ErreurTemporaire` tombent toutes deux en `echec_technique`, alors que l'une
 * se resorbe seule et l'autre demande de reprendre le parsing. C'est la
 * distinction qui decide du niveau d'alerte.
 */
export function natureDe(erreur: unknown): NatureEchec {
  if (!(erreur instanceof Error)) return "inconnue";
  switch (erreur.name) {
    case "ErreurIdentifiants":
      return "identifiants";
    case "ErreurTemporaire":
      return "temporaire";
    case "ErreurStructure":
      return "structure";
    default:
      return "inconnue";
  }
}
