/**
 * Deux regles de reservation coexistent sur le portail :
 *
 * - la CANTINE ferme le lundi minuit pour la semaine suivante. Passe ce delai,
 *   plus de recours.
 * - le PERISCOLAIRE (garderie matin et soir) se reserve jusqu'a la veille
 *   minuit.
 *
 * Toutes les dates sont des "jours calendaires" epingles a midi UTC : on ne
 * manipule jamais d'heure, seulement des dates, et midi met 12 h de marge de
 * chaque cote pour qu'aucun decalage de fuseau ne fasse changer de jour.
 */

const FUSEAU = "Europe/Paris";

export const iso = (d: Date): string => d.toISOString().slice(0, 10);

export function jourDepuisIso(s: string): Date {
  return new Date(`${s}T12:00:00Z`);
}

export function ajouter(d: Date, jours: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + jours);
  return c;
}

/**
 * Aujourd'hui, tel que le voit un parent a L'Argentiere.
 *
 * Surtout ne PAS lire les composantes locales du serveur : Vercel tourne en
 * UTC, alors que l'echeance est "lundi minuit" heure de Paris. Un run apres
 * 22 h UTC en ete tomberait deja le lendemain a Paris et viserait la mauvaise
 * semaine. On force donc le fuseau explicitement.
 */
export function aujourdhuiParis(maintenant: Date = new Date()): Date {
  const parties = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSEAU,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(maintenant);
  return jourDepuisIso(parties);
}

/**
 * Prochain lundi minuit qui ferme des reservations de cantine. Aujourd'hui si
 * on est lundi : la journee entiere reste ouverte jusqu'a minuit.
 */
export function prochaineEcheance(aujourdhui: Date): Date {
  return ajouter(aujourdhui, (1 - aujourdhui.getUTCDay() + 7) % 7);
}

/**
 * Lundi de la semaine que l'echeance verrouille.
 *
 * Ne PAS tenter de deduire cette semaine des donnees en cherchant la premiere
 * semaine encore modifiable. Le portail fonctionne en prepaiement_panier : une
 * reservation validee et payee passe en "Reserve et bloque" tout de suite,
 * bien avant son echeance. Une semaine deja reglee apparait donc verrouillee
 * alors qu'elle n'a jamais ete en retard.
 */
export const semaineVisee = (echeance: Date): Date => ajouter(echeance, 7);

/**
 * Jours de periscolaire encore rattrapables depuis aujourd'hui.
 *
 * La reservation d'un jour D ferme au minuit qui OUVRE D : le dernier jour
 * utile est donc D-1, et l'avant-dernier D-2. Vu depuis aujourd'hui, les jours
 * sur lesquels le parent peut encore agir sont exactement T+1 (dernier jour)
 * et T+2 (preavis). Le cron etant quotidien, chaque jour d'ecole est vu deux
 * fois — le lundi par les passages du samedi et du dimanche.
 *
 * ATTENTION : cette regle est DEDUITE, pas observee sur le portail. Si elle est
 * fausse, les pointages de T+1 reviendront verrouilles et l'on ne dira jamais
 * rien. C'est pourquoi `analyser` signale les pointages en
 * ETAT_BLOCAGE_DEPASSE, signature exacte d'une fenetre trop tardive.
 */
export const fenetreVeille = (aujourdhui: Date): { debut: Date; fin: Date } => ({
  debut: ajouter(aujourdhui, 1),
  fin: ajouter(aujourdhui, 2),
});

/** Lundi de la semaine contenant d. */
export const lundiDe = (d: Date): Date => ajouter(d, -((d.getUTCDay() + 6) % 7));

export function joursRestants(aujourdhui: Date, echeance: Date): number {
  return Math.round((echeance.getTime() - aujourdhui.getTime()) / 86_400_000);
}

/**
 * Jour de la semaine, 0 = lundi — comme `planning.jour_0` du portail et comme
 * `lundiDe`. A ne pas confondre avec `jours_avant`, qui compte les jours AVANT
 * l'echeance (0 = lundi dernier jour, 6 = mardi) : deux referentiels opposes.
 */
export const jourSemaine = (d: Date): number => (d.getUTCDay() + 6) % 7;

export const JOURS_SEMAINE = [
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
  "dimanche",
];

/**
 * Jours proposes dans la grille de reglages. Le week-end n'a jamais rien a
 * reserver ; le mercredi reste affiche parce que c'est le portail qui le rend
 * ferme, pas nous — coder le calendrier d'une collectivite dans l'UI ferait
 * mentir l'ecran des qu'une autre commune ouvrirait ce jour-la.
 */
export const JOURS_SEMAINE_UI = [0, 1, 2, 3, 4];

export const libelleJourSemaine = (n: number): string => JOURS_SEMAINE[n] ?? `jour ${n}`;

/**
 * L'echeance de la cantine etant toujours un lundi, "J-n" designe toujours le
 * meme jour de la semaine. On l'affiche ainsi aux parents : "samedi" parle,
 * "J-2" non. Au-dela de 6 on retomberait sur l'echeance precedente, d'ou la
 * plage 0..6.
 */
const JOURS_AVANT = ["lundi", "dimanche", "samedi", "vendredi", "jeudi", "mercredi", "mardi"];

export const JOURS_AVANT_POSSIBLES = [0, 1, 2, 3, 4, 5, 6];

/**
 * Le suffixe "(dernier jour pour la cantine)" n'a de sens que pour une famille
 * qui surveille la cantine. Une famille qui ne suit que la garderie lirait
 * sinon "lundi (dernier jour)" alors qu'aucune echeance ne tombe ce lundi-la
 * pour elle.
 */
export const libelleJourAvant = (n: number, { avecCantine = true } = {}): string => {
  const jour = JOURS_AVANT[n] ?? `J-${n}`;
  return avecCantine && n === 0 ? `${jour} (dernier jour pour la cantine)` : jour;
};

/** "lundi 21" : assez court pour une liste, assez clair pour ne pas compter. */
export const formaterJourCourt = (d: Date): string =>
  new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);

export const formaterJour = (d: Date): string =>
  new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(d);
