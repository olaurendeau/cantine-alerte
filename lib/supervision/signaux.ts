import type { ResultatCron } from "../service/verification.ts";

/**
 * Ce qu'un cycle termine a d'inquietant, et a quel point.
 *
 * Fonction pure, comme `decider()` : c'est une decision metier — « faut-il
 * reveiller quelqu'un ? » — et elle se teste sans reseau ni SDK. L'envoi
 * proprement dit vit dans `app/api/cron/supervision.ts`, qui n'a plus qu'a
 * relayer.
 *
 * ⚠️ L'asymetrie du service — « une alerte en trop est benigne, une alerte
 * manquante fait rater le repas » — NE se transpose PAS ici. Une alerte
 * d'exploitation de trop, repetee chaque jour, apprend a ne plus les lire, et
 * la vraie panne passe avec les autres. D'ou un tri serre, et une empreinte
 * fixe par signal pour que chacun reste UNE issue qui se rouvre.
 */
export type NiveauSignal = "error" | "warning";

export type Signal = {
  /** Empreinte stable : une issue par type de signal, jamais une par libelle. */
  empreinte: string;
  niveau: NiveauSignal;
  message: string;
  /** Pseudonymes et decomptes uniquement : ni adresse, ni prenom. */
  contexte: Record<string, unknown>;
};

/** Les valeurs distinctes d'un champ liste, tous parents confondus. */
function cumuler<T>(resultat: ResultatCron, champ: (t: ResultatCron["traites"][number]) => T[] | undefined): T[] {
  return [...new Set(resultat.traites.flatMap((t) => champ(t) ?? []))];
}

export function signauxDe(resultat: ResultatCron): Signal[] {
  const signaux: Signal[] = [];
  const parentsDeNature = (nature: string) =>
    resultat.traites.filter((t) => t.nature === nature).map((t) => t.parentId);

  // — error : un rappel est perdu, ou le sera demain —

  if (resultat.nonTraites > 0) {
    signaux.push({
      empreinte: "cycle-non-traites",
      niveau: "error",
      message: `${resultat.nonTraites} famille(s) non examinee(s) : le cycle n'a pas tenu dans son budget`,
      contexte: {
        nonTraites: resultat.nonTraites,
        traites: resultat.traites.length,
        interroges: resultat.interroges,
        dureeMs: resultat.dureeMs,
      },
    });
  }

  const depassees = cumuler(resultat, (t) => t.depassees);
  if (depassees.length) {
    // Le signal que la phase 3 attendait : la regle « veille minuit » du
    // periscolaire est deduite, jamais observee. Si elle est fausse, on
    // interroge des jours deja verrouilles et l'alerte ne part JAMAIS aux
    // familles — un silence que rien d'autre ne trahirait.
    signaux.push({
      empreinte: "fenetre-depassee",
      niveau: "error",
      message: `Echeance deja passee sur ${depassees.join(", ")} : la regle de delai est a revoir`,
      contexte: { surveillances: depassees, semaineVisee: resultat.semaineVisee },
    });
  }

  const structure = parentsDeNature("structure");
  if (structure.length) {
    // Un seul signal pour tous : ils ont la meme cause, le portail a change
    // quelque chose a son HTML ou a son JSON.
    signaux.push({
      empreinte: "portail-structure",
      niveau: "error",
      message: `Le portail ne repond plus ce qu'on sait lire (${structure.length} famille(s))`,
      contexte: {
        familles: structure.length,
        parentIds: structure,
        exemple: resultat.traites.find((t) => t.nature === "structure")?.detail,
      },
    });
  }

  // — warning : a regarder, sans reveiller personne —

  const temporaires = parentsDeNature("temporaire");
  if (temporaires.length) {
    // Les 429 n'arrivent jamais jusqu'ici : `aIgnorer` les ecarte a la source.
    // Restent les 5xx, donc un portail reellement en panne.
    signaux.push({
      empreinte: "portail-indisponible",
      niveau: "warning",
      message: `Portail indisponible pour ${temporaires.length} famille(s)`,
      contexte: { familles: temporaires.length, parentIds: temporaires },
    });
  }

  const echecsEnvoi = resultat.traites.filter((t) => t.statut === "echec_envoi");
  if (echecsEnvoi.length) {
    // Le verrou a ete libere, le passage suivant retentera : c'est la
    // repetition qui serait grave, pas l'occurrence isolee.
    signaux.push({
      empreinte: "envoi-echoue",
      niveau: "warning",
      message: `Expedition impossible pour ${echecsEnvoi.length} famille(s)`,
      contexte: { familles: echecsEnvoi.length, parentIds: echecsEnvoi.map((t) => t.parentId) },
    });
  }

  const absentes = cumuler(resultat, (t) => t.absentes);
  if (absentes.length) {
    signaux.push({
      empreinte: "surveillance-absente",
      niveau: "warning",
      message: `Surveillance sans prestation correspondante : ${absentes.join(", ")}`,
      contexte: { surveillances: absentes },
    });
  }

  const inconnus = cumuler(resultat, (t) => t.inconnus);
  if (inconnus.length) {
    // « Pre-reserve » et « En attente et bloque » sont annonces par la legende
    // du portail sans avoir jamais ete observes dans l'API. Leur premiere
    // apparition se joue ici.
    // ⚠️ Ne JAMAIS ajouter « Pre-reserve » a ETATS_RESERVES : ce serait taire
    // l'alerte au moment precis ou le parent a oublie de valider son panier.
    signaux.push({
      empreinte: "etat-non-repertorie",
      niveau: "warning",
      message: `Etat(s) de pointage non repertorie(s) : ${inconnus.join(", ")}`,
      contexte: { etats: inconnus },
    });
  }

  return signaux;
}
