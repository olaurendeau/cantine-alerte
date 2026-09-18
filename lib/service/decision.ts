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
  jourDeNouvelles,
  joursRestants,
  joursSilencieux,
}: {
  /** Tous perimetres verifies aujourd'hui confondus : cantine et periscolaire. */
  manquants: number;
  /**
   * Reservations effectives sur les fenetres regardees. C'est le chiffre
   * qu'annonce la confirmation, donc celui qui decide s'il y a quelque chose a
   * confirmer.
   *
   * Ne PAS se fier ici au nombre de pointages : pendant les vacances le portail
   * en renvoie tout de meme, en ETAT_PRESTATION_FERMEE et `disabled`. Les
   * compter ferait croire a une semaine pleine et renverrait le message
   * exactement quand il est faux.
   */
  reserves: number;
  /**
   * Le jour fait-il partie de ceux ou la famille veut des nouvelles ?
   *
   * Un rappel passe tous les jours — le periscolaire se joue a deux jours, il
   * ne peut pas attendre la prochaine date choisie. Une confirmation, elle,
   * suit la cadence demandee.
   */
  jourDeNouvelles: boolean;
  joursRestants: number;
  joursSilencieux: readonly number[];
}): Decision {
  if (manquants > 0) return "rappel";
  // Un passage declenche par le seul periscolaire n'a rien a confirmer : on n'a
  // meme pas regarde la semaine visee, et l'annoncer couverte serait faux.
  if (!jourDeNouvelles) return "silence";
  // Ni reservation a faire, ni reservation faite : periode fermee cote portail.
  // Le cas couvre les vacances et les semaines hors annee scolaire, ou
  // confirmer annoncerait au parent une semaine couverte pour zero repas.
  if (reserves === 0) return "silence";
  return joursSilencieux.includes(joursRestants) ? "silence" : "confirmation";
}
