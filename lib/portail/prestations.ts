import { API } from "./auth.ts";
import { ajouter, iso, jourDepuisIso, lundiDe } from "./dates.ts";
import type { Session } from "./session.ts";
import type { Cible, ConfigPortail, Logger, Pointage } from "./types.ts";
import { silencieux } from "./types.ts";

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
 * Etats connus ne valant pas reservation, rapproches de la legende du portail.
 * "Bloque a la reservation" remonte sous deux codes distincts selon la cause
 * (hors periode scolaire, ou echeance depassee).
 */
export const ETATS_NON_RESERVES = new Set([
  "ETAT_NON_RESERVE", // "Disponible a la reservation"
  "ETAT_PRESTATION_FERMEE", // "Non disponible"
  "ETAT_BLOCAGE", // "Bloque a la reservation"
  "ETAT_BLOCAGE_DEPASSE", // "Bloque a la reservation"
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
  if (!res.ok) throw new Error(`prestations HTTP ${res.status} : ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}

/**
 * data.pointages est un dictionnaire indexe "<fkindividu>|<fkprestation>|<date>",
 * pas un tableau. Structure observee en conditions reelles.
 */
function pointages(payload: Payload): Pointage[] {
  const d = payload?.data;
  if (!d || typeof d.pointages !== "object") {
    throw new Error("Structure inattendue : data.pointages absent. Le portail a change.");
  }
  return Object.values(d.pointages);
}

/** Identifiants des prestations dont le code ou le libelle correspond. */
function prestationsSurveillees(payload: Payload, motif: RegExp): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, o] of Object.entries(payload?.data?.prestations ?? {})) {
    const p = o?.prestation ?? {};
    const libelle = p.libelle ?? id;
    if (motif.test(p.code ?? "") || motif.test(libelle)) out.set(String(id), libelle);
  }
  return out;
}

/** fkindividu -> prenom, pour nommer l'enfant dans les alertes. */
function enfants(payload: Payload): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of payload?.data?.individus ?? []) {
    out.set(String(i.fkindividu), i.prenom ?? `#${i.fkindividu}`);
  }
  return out;
}

export type Analyse = {
  manquants: Cible[];
  reserves: Cible[];
  bloques: Cible[];
  retenus: Pointage[];
  inconnus: string[];
  prestas: Map<string, string>;
  prenoms: Map<string, string>;
};

/**
 * Croise les pointages du portail avec la fenetre surveillee. Un manquant est
 * un couple (jour, enfant) : une reservation posee pour un seul enfant ne
 * couvre pas la fratrie.
 */
export function analyser(payload: Payload, cfg: ConfigPortail, debut: Date, fin: Date): Analyse {
  const prestas = prestationsSurveillees(payload, cfg.prestation);
  if (prestas.size === 0) {
    const offertes = Object.values(payload?.data?.prestations ?? {})
      .map((o) => `${o?.prestation?.code} (${o?.prestation?.libelle})`)
      .join(", ");
    throw new Error(
      `Aucune prestation ne correspond a ${cfg.prestation}. Prestations offertes : ${offertes}.`,
    );
  }
  const prenoms = enfants(payload);
  const retenus = pointages(payload).filter(
    (pt) => prestas.has(String(pt.fkprestation)) && pt.date >= iso(debut) && pt.date <= iso(fin),
  );

  const decrire = (pt: Pointage): Cible => ({
    date: jourDepuisIso(pt.date),
    enfant: prenoms.get(String(pt.fkindividu)) ?? `#${pt.fkindividu}`,
    prestation: prestas.get(String(pt.fkprestation)) ?? String(pt.fkprestation),
    code: pt.code_etat,
  });

  // Un jour verrouille n'appelle aucune action du parent : jour non propose
  // (mercredi, vacances) ou echeance deja passee. Le signaler serait du bruit.
  const bloques = retenus.filter((pt) => !estReserve(pt) && pt.disabled);
  const manquants = retenus
    .filter((pt) => !estReserve(pt) && !pt.disabled && !cfg.exclusions.has(pt.date))
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
    prestas,
    prenoms,
  };
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
    l.map((c) => `${iso(c.date)} ${c.enfant}`).join(", ") || "aucun";
  return [
    "--- lecture du payload ---",
    `enfants : ${[...a.prenoms].map(([id, p]) => `${p} (${id})`).join(", ") || "aucun"}`,
    `prestations surveillees : ${[...a.prestas].map(([id, l]) => `${l} (${id})`).join(", ")}`,
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
