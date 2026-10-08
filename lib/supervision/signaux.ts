import { sansAdresses } from "./anonymiser.ts";
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

/**
 * Au-dela de ce nombre de cycles consecutifs en echec, une indisponibilite
 * n'est plus passagere.
 *
 * Trois cycles valent environ un jour et demi, le cron passant deux fois par
 * jour. Volontairement aligne sur le seuil de desactivation d'un compte, qui
 * repose sur le meme raisonnement : trois fois d'affilee, ce n'est plus un
 * accident. Ce sont deux decisions distinctes, d'ou deux constantes.
 */
const SEUIL_PANNE_DURABLE = 3;

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
        exemple: sansAdresses(resultat.traites.find((t) => t.nature === "structure")?.detail ?? ""),
      },
    });
  }

  const horsCycle = parentsDeNature("cycle");
  if (horsCycle.length) {
    // Le filet de derniere instance d'`executerCron` : une erreur a echappe a
    // `traiterParent`. On ne sait pas ce que c'est, et c'est bien le probleme —
    // ce chemin court-circuite `alerter()`, donc la famille n'a meme pas recu
    // de mail d'echec technique.
    signaux.push({
      empreinte: "erreur-non-rattrapee",
      niveau: "error",
      message: `Erreur non rattrapee dans le cycle pour ${horsCycle.length} famille(s)`,
      contexte: {
        familles: horsCycle.length,
        parentIds: horsCycle,
        exemple: sansAdresses(resultat.traites.find((t) => t.nature === "cycle")?.detail ?? ""),
      },
    });
  }

  const inattendues = parentsDeNature("inconnue");
  if (inattendues.length) {
    // Erreur non classee sortie du `catch` de `traiterParent` — un 419 Laravel,
    // par exemple, qui leve une Error nue. ⚠️ Contrairement au cas ci-dessus,
    // `alerter()` a bien tourne : le parent a ete prevenu. Les confondre
    // enverrait chercher un bug de boucle la ou le parent est au courant.
    signaux.push({
      empreinte: "erreur-non-classee",
      niveau: "warning",
      message: `Erreur non classee pour ${inattendues.length} famille(s)`,
      contexte: {
        familles: inattendues.length,
        parentIds: inattendues,
        exemple: sansAdresses(resultat.traites.find((t) => t.nature === "inconnue")?.detail ?? ""),
      },
    });
  }

  // — warning : a regarder, sans reveiller personne —

  const temporaires = resultat.traites.filter((t) => t.nature === "temporaire");
  if (temporaires.length) {
    // 429 (debit limite), 401/403 (session refusee) et 5xx (portail en panne).
    // ⚠️ `aIgnorer` ne les ecarte PAS ici : il s'applique dans `beforeSend` sur
    // l'exception d'origine, or ces signaux sont des `captureMessage` sans
    // exception. Un throttling remonte donc bien, ce qui est souhaitable — il
    // dit que le service s'est fait freiner.
    const duree = Math.max(0, ...temporaires.map((t) => t.echecsConsecutifs ?? 0));
    // ⚠️ Au-dela de ce seuil, ce n'est plus un hoquet. Sans cette escalade, une
    // panne PERMANENTE — cle de tenant revoquee, point d'entree passe derriere
    // un nouveau scope — se contenterait d'un warning quotidien, noye dans la
    // meme issue que les coupures de cinq minutes, pendant que toutes les
    // familles perdent tous leurs rappels. L'empreinte differe aussi : noyer
    // l'une dans l'autre reviendrait a ne pas escalader du tout.
    const durable = duree >= SEUIL_PANNE_DURABLE;
    signaux.push({
      empreinte: durable ? "portail-indisponible-durable" : "portail-indisponible",
      niveau: durable ? "error" : "warning",
      message: durable
        ? `Portail indisponible depuis ${duree} cycles pour ${temporaires.length} famille(s) : ` +
          "ce n'est plus passager"
        : `Portail indisponible pour ${temporaires.length} famille(s)`,
      contexte: {
        familles: temporaires.length,
        parentIds: temporaires.map((t) => t.parentId),
        echecsConsecutifs: duree,
      },
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
