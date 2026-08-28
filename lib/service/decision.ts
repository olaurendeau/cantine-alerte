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
  joursRestants,
  joursSilencieux,
}: {
  manquants: number;
  joursRestants: number;
  joursSilencieux: readonly number[];
}): Decision {
  if (manquants > 0) return "rappel";
  return joursSilencieux.includes(joursRestants) ? "silence" : "confirmation";
}
