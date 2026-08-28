export type Decision = "rappel" | "confirmation" | "silence";

/**
 * Que faire a l'issue d'une verification.
 *
 * Le defaut est de confirmer meme quand tout va bien : une boite vide ne dit
 * pas au parent si tout est reserve ou si le service est tombe. Il peut
 * neanmoins couper cette confirmation jour par jour, d'ou `joursSilencieux`,
 * exprime en negatif pour que la liste vide vaille "confirmer partout".
 */
export function decider({
  manquants,
  retenus,
  joursRestants,
  joursSilencieux,
}: {
  manquants: number;
  /**
   * Pointages de la prestation surveillee sur la fenetre. Zero signifie que le
   * portail ne propose rien du tout : vacances, ou hors annee scolaire.
   */
  retenus: number;
  joursRestants: number;
  joursSilencieux: readonly number[];
}): Decision {
  // Aucun pointage n'est pas la meme chose que "tout est reserve" : il n'y a
  // rien a confirmer. Sans ce garde, chaque semaine de vacances envoie a tous
  // les parents un "Rien a faire, tout est reserve" annoncant zero repas.
  if (retenus === 0) return "silence";
  if (manquants > 0) return "rappel";
  return joursSilencieux.includes(joursRestants) ? "silence" : "confirmation";
}
