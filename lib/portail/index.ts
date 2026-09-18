import { login } from "./auth.ts";
import {
  ajouter,
  fenetreVeille,
  iso,
  joursRestants,
  jourSemaine,
  prochaineEcheance,
  semaineVisee,
} from "./dates.ts";
import { analyser, getPrestations, type Analyse, type Fenetre } from "./prestations.ts";
import { nouvelleSession } from "./session.ts";
import type { CleSurveillance, ConfigPortail, Logger } from "./types.ts";
import { silencieux } from "./types.ts";

export * from "./auth.ts";
export * from "./dates.ts";
export * from "./prestations.ts";
export * from "./session.ts";
export * from "./types.ts";

/** Les reglages d'une famille, tels que `fenetresPour` en a besoin. */
export type ReglagesSurveillance = {
  /** Jours ou la famille veut des nouvelles, en J-n avant l'echeance cantine. */
  joursAvant: readonly number[];
  /** Jours de semaine SANS cantine (0 = lundi). Stocke en negatif : vide = tous. */
  joursSansCantine: readonly number[];
  /** Jours de semaine AVEC periscolaire (0 = lundi). Stocke en positif : vide = aucun. */
  joursMatin: readonly number[];
  joursSoir: readonly number[];
  /** Semaine visee mise en silence pour la cantine (YYYY-MM-DD), ou null. */
  pauseSemaine: string | null;
};

const TOUS_LES_JOURS = [0, 1, 2, 3, 4, 5, 6];

/** Reglages du CLI de diagnostic : tout surveiller, ne rien ecarter. */
export const REGLAGES_TOUT: ReglagesSurveillance = {
  joursAvant: TOUS_LES_JOURS,
  joursSansCantine: [],
  joursMatin: TOUS_LES_JOURS,
  joursSoir: TOUS_LES_JOURS,
  pauseSemaine: null,
};

/**
 * Quelles fenetres interroger aujourd'hui pour cette famille.
 *
 * C'est LE point de verite du service : tout le reste en decoule
 * mecaniquement. Une fenetre cantine non construite, et il n'y a ni manquants,
 * ni reserves, ni section de mail, ni confirmation — sans une seule condition
 * ailleurs. Porter la meme regle dans `decider()` et dans la composition du
 * mail l'eparpillerait en conditions devant rester d'accord entre elles.
 *
 * Rend un tableau vide quand il n'y a rien a regarder : c'est le signal de ne
 * PAS appeler le portail, qui est la ressource rare.
 */
export function fenetresPour({
  aujourdhui,
  reglages,
  exclusions = new Set<string>(),
  semaines = 1,
}: {
  aujourdhui: Date;
  reglages: ReglagesSurveillance;
  /** Dates absolues posees par la collectivite. Cf. ConfigPortail.exclusions. */
  exclusions?: ReadonlySet<string>;
  semaines?: number;
}): Fenetre[] {
  // `jours_avant` vide est l'interrupteur general : c'est ce que pose le lien
  // "Ne plus recevoir de rappels". Sans ce garde, le periscolaire — qui ne
  // depend pas des jours choisis — continuerait d'ecrire a une famille
  // desabonnee, et le lien mentirait.
  if (reglages.joursAvant.length === 0) return [];

  const echeance = prochaineEcheance(aujourdhui);
  const semaine = semaineVisee(echeance);
  const restants = joursRestants(aujourdhui, echeance);
  const fenetres: Fenetre[] = [];

  const jourDeNouvelles = reglages.joursAvant.includes(restants);
  const enPause = reglages.pauseSemaine === iso(semaine);
  if (jourDeNouvelles && !enPause) {
    fenetres.push({
      cle: "cantine",
      debut: semaine,
      fin: ajouter(semaine, semaines * 7 - 1),
      joursAttendus: new Set(TOUS_LES_JOURS.filter((j) => !reglages.joursSansCantine.includes(j))),
      // Les exclusions de la collectivite (sortie scolaire avec pique-nique)
      // suppriment le repas, pas la garderie du matin : cantine seule.
      exclusions,
      requise: true,
    });
  }

  const { debut, fin } = fenetreVeille(aujourdhui);
  const concernes = [jourSemaine(debut), jourSemaine(fin)];
  for (const [cle, jours] of [
    ["matin", reglages.joursMatin],
    ["soir", reglages.joursSoir],
  ] as [CleSurveillance, readonly number[]][]) {
    // Inutile de faire le voyage si aucun des deux jours rattrapables n'est
    // attendu par la famille.
    if (!concernes.some((j) => jours.includes(j))) continue;
    fenetres.push({
      cle,
      debut,
      fin,
      joursAttendus: new Set(jours),
      exclusions: new Set<string>(),
      requise: false,
    });
  }

  return fenetres;
}

export type Resultat = {
  echeance: Date;
  semaine: Date;
  joursRestants: number;
  fenetres: Fenetre[];
  analyse: Analyse;
};

/**
 * Un cycle complet pour un parent : une connexion, UNE requete couvrant
 * l'union des fenetres, une analyse. Partage par le CLI de diagnostic et par
 * le cron, pour qu'ils ne puissent pas diverger.
 *
 * L'union est ce qui rend le periscolaire gratuit : le portail ne filtre rien
 * par prestation, il renvoie deja Gmat, Gsoir, RepE et ACCu sur toute la plage
 * demandee. Multiplier les requetes entamerait le budget de session de 45 s.
 *
 * Ne compose aucun message : `lib/portail` ne connait que le portail, la mise
 * en forme appartient a `lib/mail`.
 */
export async function verifierParent(
  cfg: ConfigPortail,
  {
    aujourdhui,
    fenetres,
    trace = silencieux,
  }: { aujourdhui: Date; fenetres: Fenetre[]; trace?: Logger },
): Promise<Resultat> {
  if (fenetres.length === 0) {
    throw new Error("verifierParent appele sans fenetre : il n'y a rien a interroger.");
  }
  const echeance = prochaineEcheance(aujourdhui);
  const semaine = semaineVisee(echeance);
  const restants = joursRestants(aujourdhui, echeance);

  const debut = fenetres.reduce((a, f) => (f.debut < a ? f.debut : a), fenetres[0].debut);
  const fin = fenetres.reduce((a, f) => (f.fin > a ? f.fin : a), fenetres[0].fin);

  const session = nouvelleSession(trace);
  const bearer = await login(cfg, session, trace);
  const payload = await getPrestations(cfg, session, bearer, debut, fin, trace);
  const analyse = analyser(payload, cfg, fenetres);

  return { echeance, semaine, joursRestants: restants, fenetres, analyse };
}

/**
 * Dates a ignorer, depuis l'environnement. Extraite pour que le cron puisse les
 * lire sans construire une config complete, qui exige des identifiants.
 */
export const exclusionsDepuisEnv = (env: NodeJS.ProcessEnv): Set<string> =>
  new Set((env.CANTINE_EXCLUSIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

/** Collectivite ciblee par defaut, partagee par la config et les liens des mails. */
export const PORTAIL_DEFAUT = "argentiere";

/** Config depuis l'environnement, pour le CLI et les valeurs par defaut de la collectivite. */
export function configDepuisEnv(
  env: NodeJS.ProcessEnv,
  identifiants?: { email: string; password: string },
): ConfigPortail {
  const email = identifiants?.email ?? env.CANTINE_EMAIL;
  const password = identifiants?.password ?? env.CANTINE_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Identifiants portail manquants (CANTINE_EMAIL / CANTINE_PASSWORD, ou parametre).",
    );
  }
  return {
    email,
    password,
    bdd: env.CANTINE_BDD ?? "cantine2_argentiere",
    apiKey: env.CANTINE_API_KEY ?? "cantine2",
    dbId: env.CANTINE_DB_ID ?? "8089",
    typeId: env.CANTINE_TYPE_ID ?? "9",
    portail: env.CANTINE_PORTAIL ?? PORTAIL_DEFAUT,
    motifs: {
      cantine: new RegExp(env.CANTINE_PRESTATION ?? "RepE|Repas enfant", "i"),
      matin: new RegExp(env.CANTINE_PRESTATION_MATIN ?? "Gmat|Garderie matin", "i"),
      soir: new RegExp(env.CANTINE_PRESTATION_SOIR ?? "Gsoir|Garderie soir", "i"),
    },
    exclusions: exclusionsDepuisEnv(env),
  };
}
