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
  reserves,
  joursRestants,
  joursSilencieux,
}: {
  manquants: number;
  /**
   * Repas effectivement reserves sur la fenetre. C'est le chiffre qu'annonce la
   * confirmation, donc celui qui decide s'il y a quelque chose a confirmer.
   *
   * Ne PAS se fier ici au nombre de pointages : pendant les vacances le portail
   * en renvoie tout de meme, en ETAT_PRESTATION_FERMEE et `disabled`. Les
   * compter ferait croire a une semaine pleine et renverrait le message
   * exactement quand il est faux.
   */
  reserves: number;
  joursRestants: number;
  joursSilencieux: readonly number[];
}): Decision {
  if (manquants > 0) return "rappel";
  // Ni repas reserve, ni repas a reserver : il n'y a rien a confirmer. Le cas
  // couvre les vacances et les semaines hors annee scolaire, ou confirmer
  // annoncerait au parent une semaine couverte pour zero repas.
  if (reserves === 0) return "silence";
  return joursSilencieux.includes(joursRestants) ? "silence" : "confirmation";
}
