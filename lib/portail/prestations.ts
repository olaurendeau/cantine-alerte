import { API, ErreurStructure, refuserSiIndisponible } from "./auth.ts";
import { ajouter, iso, jourDepuisIso, jourSemaine, lundiDe } from "./dates.ts";
import type { Session } from "./session.ts";
import type { Cible, CleSurveillance, ConfigPortail, Logger, Pointage } from "./types.ts";
import { LIBELLES_SURVEILLANCE, silencieux } from "./types.ts";

/**
 * Etats valant reservation effective. Liste blanche volontaire : tout code hors
 * de cette liste compte comme NON reserve, une alerte en trop etant benigne
 * quand une alerte manquante fait rater le repas.
 *
 * Ne JAMAIS y ajouter l'etat pre-reserve : la prestation fonctionne en
 * "prepaiement_panier" et l'interface distingue explicitement "Pre-reserve"
 * (panier non valide) de "Reserve". Compter le panier comme une reservation
 * ferait taire l'alerte au moment ou le parent a justement oublie de valider.
 */
export const ETATS_RESERVES = new Set(["ETAT_RESERVE", "ETAT_BLOCAGE_RESERVE", "ETAT_FACTURE"]);

/**
 * "Bloque a la reservation" remonte sous deux codes distincts selon la cause,
 * et la distinction est exploitee plus bas : ETAT_PRESTATION_FERMEE = jour non
 * propose (mercredi, vacances), ETAT_BLOCAGE_DEPASSE = echeance deja passee.
 */
export const ETAT_DEPASSE = "ETAT_BLOCAGE_DEPASSE";

export const ETATS_NON_RESERVES = new Set([
  "ETAT_NON_RESERVE", // "Disponible a la reservation"
  "ETAT_PRESTATION_FERMEE", // "Non disponible"
  "ETAT_BLOCAGE", // "Bloque a la reservation"
  ETAT_DEPASSE, // "Bloque a la reservation", echeance passee
]);

export const estReserve = (pt: Pointage): boolean => ETATS_RESERVES.has(String(pt.code_etat ?? ""));

const codeConnu = (pt: Pointage): boolean =>
  ETATS_RESERVES.has(String(pt.code_etat ?? "")) || ETATS_NON_RESERVES.has(String(pt.code_etat ?? ""));

export type Payload = {
  data?: {
    pointages?: Record<string, Pointage>;
    prestations?: Record<string, { prestation?: { code?: string; libelle?: string } }>;
    individus?: { fkindividu: string | number; prenom?: string }[];
  };
};

/**
 * Une prestation surveillee sur une plage de dates, avec les jours de semaine
 * ou la famille attend reellement une reservation.
 *
 * C'est l'unite de travail du service : chaque surveillance a sa propre regle
 * d'echeance, donc sa propre plage, et les plages ne se recouvrent pas. Le
 * portail ne filtrant rien par prestation, une seule requete couvrant l'union
 * des plages suffit a les servir toutes.
 */
export type Fenetre = {
  cle: CleSurveillance;
  debut: Date;
  fin: Date;
  /** Jours de semaine attendus, 0 = lundi. Un jour absent n'est jamais un manquant. */
  joursAttendus: ReadonlySet<number>;
  /** Dates absolues a ignorer (YYYY-MM-DD). Cantine seule, cf. ConfigPortail. */
  exclusions: ReadonlySet<string>;
  /** La cantine est requise : son absence du portail est une erreur de structure. */
  requise: boolean;
};

export async function getPrestations(
  cfg: ConfigPortail,
  session: Session,
  bearer: string,
  debut: Date,
  fin: Date,
  trace: Logger = silencieux,
): Promise<Payload> {
  trace(`[5] prestations du ${iso(debut)} au ${iso(fin)}`);
  const res = await session.go(`${API}/api/adulte/prestations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      bdd: cfg.bdd,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type_pointage: "R", date_start: iso(debut), date_end: iso(fin) }),
  });
  const txt = await res.text();
  // Meme classification qu'a la connexion : un 429 ne doit pas etre rejoue
  // (insister prolonge le blocage par IP), un 5xx merite un nouvel essai.
  refuserSiIndisponible(res.status, "la lecture des prestations");
  if (!res.ok) {
    // Tout le reste (401, 403, 404) rendra la meme chose au coup suivant, et
    // chaque tentative refait les quatre sauts de connexion : trois essais
    // coutent douze requetes depuis la meme IP pour rien, ce qui pousse
    // justement vers le 429 qu'on s'applique a eviter.
    throw new ErreurStructure(
      `prestations HTTP ${res.status}, statut inattendu : ${txt.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(txt);
  } catch {
    // Un 200 dont le corps n'est pas du JSON : page de maintenance ou portail
    // interstitiel. Rejouer donnerait la meme chose.
    throw new ErreurStructure(
      `Reponse /api/adulte/prestations non JSON (HTTP ${res.status}) : ${txt.slice(0, 200)}`,
    );
  }
}

/**
 * data.pointages est un dictionnaire indexe "<fkindividu>|<fkprestation>|<date>",
 * pas un tableau. Structure observee en conditions reelles.
 */
function pointages(payload: Payload): Pointage[] {
  const d = payload?.data;
  if (!d || typeof d.pointages !== "object") {
    throw new ErreurStructure("Structure inattendue : data.pointages absent. Le portail a change.");
  }
  return Object.values(d.pointages);
}

/** fkindividu -> prenom, pour nommer l'enfant dans les alertes. */
function enfants(payload: Payload): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of payload?.data?.individus ?? []) {
    out.set(String(i.fkindividu), i.prenom ?? `#${i.fkindividu}`);
  }
  return out;
}

const listerOffertes = (payload: Payload): string =>
  Object.values(payload?.data?.prestations ?? {})
    .map((o) => `${o?.prestation?.code} (${o?.prestation?.libelle})`)
    .join(", ");

type PrestationSurveillee = { libelle: string; fenetre: Fenetre };

/**
 * Rattache chaque id de prestation a la fenetre qui la surveille.
 *
 * Une prestation reclamee par deux motifs est refusee : son pointage serait
 * compte deux fois, une fois par fenetre, et la config fautive passerait
 * inapercue derriere des chiffres simplement trop grands.
 */
function rattacher(
  payload: Payload,
  cfg: ConfigPortail,
  fenetres: Fenetre[],
): { prestas: Map<string, PrestationSurveillee>; absentes: CleSurveillance[] } {
  const prestas = new Map<string, PrestationSurveillee>();
  const absentes: CleSurveillance[] = [];

  for (const fenetre of fenetres) {
    const motif = cfg.motifs[fenetre.cle];
    let trouvee = 0;
    for (const [id, o] of Object.entries(payload?.data?.prestations ?? {})) {
      const p = o?.prestation ?? {};
      const libelle = p.libelle ?? id;
      if (!motif.test(p.code ?? "") && !motif.test(libelle)) continue;

      const deja = prestas.get(String(id));
      if (deja) {
        throw new ErreurStructure(
          `La prestation ${libelle} correspond a la fois a ${deja.fenetre.cle} et a ` +
            `${fenetre.cle} : ses pointages seraient comptes deux fois. Affinez ` +
            "CANTINE_PRESTATION / CANTINE_PRESTATION_MATIN / CANTINE_PRESTATION_SOIR.",
        );
      }
      prestas.set(String(id), { libelle, fenetre });
      trouvee++;
    }

    if (trouvee > 0) continue;
    if (fenetre.requise) {
      throw new ErreurStructure(
        `Aucune prestation ne correspond a ${motif}. Prestations offertes : ${listerOffertes(payload)}.`,
      );
    }
    // Une collectivite sans garderie ne doit pas casser le service pour tout le
    // monde : on le signale au lieu de lever.
    absentes.push(fenetre.cle);
  }

  return { prestas, absentes };
}

export type Analyse = {
  manquants: Cible[];
  reserves: Cible[];
  bloques: Cible[];
  retenus: Pointage[];
  inconnus: string[];
  /** Surveillances demandees dont aucune prestation n'existe sur ce portail. */
  absentes: CleSurveillance[];
  /**
   * Surveillances dont un pointage retenu revient en ETAT_BLOCAGE_DEPASSE.
   * Signature d'une fenetre calculee trop tard : on interroge des jours dont
   * l'echeance est deja passee, donc on ne previendra jamais a temps.
   */
  fenetresDepassees: CleSurveillance[];
  prestas: Map<string, PrestationSurveillee>;
  prenoms: Map<string, string>;
};

/**
 * Croise les pointages du portail avec les fenetres surveillees. Un manquant
 * est un couple (jour, enfant) : une reservation posee pour un seul enfant ne
 * couvre pas la fratrie.
 *
 * Chaque fenetre porte sa propre plage de dates, parce que la cantine et le
 * periscolaire n'ont pas la meme echeance.
 */
export function analyser(payload: Payload, cfg: ConfigPortail, fenetres: Fenetre[]): Analyse {
  const { prestas, absentes } = rattacher(payload, cfg, fenetres);
  const prenoms = enfants(payload);

  const fenetreDe = (pt: Pointage): Fenetre | null => {
    const p = prestas.get(String(pt.fkprestation));
    if (!p) return null;
    const { debut, fin } = p.fenetre;
    return pt.date >= iso(debut) && pt.date <= iso(fin) ? p.fenetre : null;
  };

  const retenus = pointages(payload).filter((pt) => fenetreDe(pt) !== null);

  const decrire = (pt: Pointage): Cible => {
    const p = prestas.get(String(pt.fkprestation));
    return {
      date: jourDepuisIso(pt.date),
      enfant: prenoms.get(String(pt.fkindividu)) ?? `#${pt.fkindividu}`,
      prestation: p?.libelle ?? String(pt.fkprestation),
      cle: p?.fenetre.cle ?? "cantine",
      code: pt.code_etat,
    };
  };

  // Un jour verrouille n'appelle aucune action du parent : jour non propose
  // (mercredi, vacances) ou echeance deja passee. Le signaler serait du bruit.
  const bloques = retenus.filter((pt) => !estReserve(pt) && pt.disabled);

  const manquants = retenus
    .filter((pt) => {
      if (estReserve(pt) || pt.disabled) return false;
      const f = fenetreDe(pt)!;
      // Deux filtres distincts : les exclusions sont des dates absolues posees
      // par la collectivite, les jours attendus une preference de la famille.
      if (f.exclusions.has(pt.date)) return false;
      return f.joursAttendus.has(jourSemaine(jourDepuisIso(pt.date)));
    })
    .map(decrire)
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.enfant.localeCompare(b.enfant));

  return {
    manquants,
    reserves: retenus.filter(estReserve).map(decrire),
    bloques: bloques.map(decrire),
    retenus,
    // Un code non repertorie est traite comme non reserve : on le signale pour
    // qu'il soit classe plutot que subi silencieusement.
    inconnus: [...new Set(retenus.filter((pt) => !codeConnu(pt)).map((pt) => pt.code_etat))],
    absentes,
    fenetresDepassees: [
      ...new Set(
        retenus.filter((pt) => pt.code_etat === ETAT_DEPASSE).map((pt) => fenetreDe(pt)!.cle),
      ),
    ],
    prestas,
    prenoms,
  };
}

/**
 * Ce qui aurait ete signale sans les reglages de la famille : jours de semaine
 * decoches, ou dates exclues par la collectivite.
 *
 * Sert l'ecran « verifier maintenant » : montrer le resultat filtre repond a la
 * question « est-ce que ca marche », mais taire ce qui a ete ecarte rendrait un
 * reglage trop restrictif indetectable — or c'est justement le nouveau moyen de
 * ne plus etre alerte par erreur.
 */
export function ecartesParReglages(a: Analyse): Cible[] {
  const dansManquants = new Set(a.manquants.map((m) => `${iso(m.date)}|${m.enfant}|${m.cle}`));
  return a.retenus
    .filter((pt) => !estReserve(pt) && !pt.disabled)
    .map((pt) => {
      const p = a.prestas.get(String(pt.fkprestation));
      return {
        date: jourDepuisIso(pt.date),
        enfant: a.prenoms.get(String(pt.fkindividu)) ?? `#${pt.fkindividu}`,
        prestation: p?.libelle ?? String(pt.fkprestation),
        cle: p?.fenetre.cle ?? "cantine",
        code: pt.code_etat,
      } satisfies Cible;
    })
    .filter((c) => !dansManquants.has(`${iso(c.date)}|${c.enfant}|${c.cle}`))
    .sort((a2, b) => a2.date.getTime() - b.date.getTime() || a2.enfant.localeCompare(b.enfant));
}

export function rapportStructure(a: Analyse): string {
  const etats = new Map<string, number>();
  const semaines = new Map<string, { ouverts: number; verrouilles: number }>();
  for (const pt of a.retenus) {
    const k = `${pt.code_etat} (etat=${pt.etat}${pt.disabled ? ", verrouille" : ""})`;
    etats.set(k, (etats.get(k) ?? 0) + 1);
    const s = iso(lundiDe(jourDepuisIso(pt.date)));
    if (!semaines.has(s)) semaines.set(s, { ouverts: 0, verrouilles: 0 });
    semaines.get(s)![pt.disabled ? "verrouilles" : "ouverts"]++;
  }
  const decrire = (l: Cible[]) =>
    l.map((c) => `${iso(c.date)} ${c.enfant} [${c.cle}]`).join(", ") || "aucun";
  return [
    "--- lecture du payload ---",
    `enfants : ${[...a.prenoms].map(([id, p]) => `${p} (${id})`).join(", ") || "aucun"}`,
    `prestations surveillees : ${
      [...a.prestas].map(([id, p]) => `${p.libelle} (${id}, ${p.fenetre.cle})`).join(", ") || "aucune"
    }`,
    ...(a.absentes.length
      ? [`surveillances ABSENTES du portail : ${a.absentes.map((c) => LIBELLES_SURVEILLANCE[c]).join(", ")}`]
      : []),
    ...(a.fenetresDepassees.length
      ? [
          `FENETRE TROP TARDIVE pour : ${a.fenetresDepassees.join(", ")} — des pointages ` +
            "interroges ont deja depasse leur echeance, l'alerte arriverait trop tard",
        ]
      : []),
    `pointages retenus : ${a.retenus.length}`,
    `etats rencontres : ${[...etats].map(([k, n]) => `${k} x${n}`).join(" ; ")}`,
    ...(a.inconnus.length ? [`etats NON REPERTORIES : ${a.inconnus.join(", ")}`] : []),
    ...[...semaines]
      .sort()
      .map(([s, n]) => `  semaine du ${s} : ${n.ouverts} ouverts, ${n.verrouilles} verrouilles`),
    `deja reserves : ${decrire(a.reserves)}`,
    `verrouilles non reserves : ${decrire(a.bloques)}`,
    `a reserver : ${decrire(a.manquants)}`,
  ].join("\n");
}

export { ajouter };
