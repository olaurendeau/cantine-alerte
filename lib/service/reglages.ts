import { eq } from "drizzle-orm";
import { chiffrer, VERSION_CLE_COURANTE } from "../crypto.ts";
import { db } from "../db/index.ts";
import { destinataires, identifiantsPortail, parents, rappels } from "../db/schema.ts";
import { expediteur } from "../mail/index.ts";
import { mailConfirmation, mailRappel } from "../mail/messages.ts";
import {
  ErreurIdentifiants,
  aujourdhuiParis,
  configDepuisEnv,
  iso,
  verifierParent,
} from "../portail/index.ts";
import { reessayer } from "../reessayer.ts";
import { decider } from "./decision.ts";
import { liensPour } from "./verification.ts";
import {
  ecartesParReglages,
  fenetresPour,
  exclusionsDepuisEnv,
  joursRestants as calculerRestants,
  prochaineEcheance,
  semaineVisee,
  type ReglagesSurveillance,
} from "../portail/index.ts";
import { LIBELLES_SURVEILLANCE } from "../portail/types.ts";

export type Reglages = {
  email: string;
  actif: boolean;
  portailEmail: string | null;
  /** On expose l'existence du mot de passe, jamais sa valeur. */
  motDePasseEnregistre: boolean;
  verifieLe: Date | null;
  echecsConsecutifs: number;
  derniereErreur: string | null;
  destinataires: string[];
  joursAvant: number[];
  joursSilencieux: number[];
  /**
   * Jours de semaine AVEC cantine attendue, 0 = lundi.
   *
   * Rendu en positif pour l'ecran, alors que la base stocke l'inverse
   * (`jours_sans_cantine`) : cocher est ce que fait le parent, mais c'est la
   * liste vide qui doit valoir « surveiller partout » cote base.
   */
  joursCantine: number[];
  joursMatin: number[];
  joursSoir: number[];
  /** Semaine visee mise en silence pour la cantine (YYYY-MM-DD), ou null. */
  pauseSemaine: string | null;
};

/** Tous les jours de semaine, 0 = lundi. Reference de la conversion positif/negatif. */
const TOUS_LES_JOURS = [0, 1, 2, 3, 4, 5, 6];

export async function chargerReglages(parentId: string): Promise<Reglages | null> {
  const [parent] = await db
    .select({ email: parents.email, actif: parents.actif })
    .from(parents)
    .where(eq(parents.id, parentId));
  if (!parent) return null;

  const [ids] = await db
    .select({
      portailEmail: identifiantsPortail.portailEmail,
      verifieLe: identifiantsPortail.verifieLe,
      echecsConsecutifs: identifiantsPortail.echecsConsecutifs,
      derniereErreur: identifiantsPortail.derniereErreur,
    })
    .from(identifiantsPortail)
    .where(eq(identifiantsPortail.parentId, parentId));

  const [rap] = await db
    .select({
      joursAvant: rappels.joursAvant,
      joursSilencieux: rappels.joursSilencieux,
      joursSansCantine: rappels.joursSansCantine,
      joursMatin: rappels.joursMatin,
      joursSoir: rappels.joursSoir,
      pauseSemaine: rappels.pauseSemaine,
    })
    .from(rappels)
    .where(eq(rappels.parentId, parentId));

  const adresses = await db
    .select({ email: destinataires.email })
    .from(destinataires)
    .where(eq(destinataires.parentId, parentId));

  return {
    email: parent.email,
    actif: parent.actif,
    portailEmail: ids?.portailEmail ?? null,
    motDePasseEnregistre: Boolean(ids),
    verifieLe: ids?.verifieLe ?? null,
    echecsConsecutifs: ids?.echecsConsecutifs ?? 0,
    derniereErreur: ids?.derniereErreur ?? null,
    destinataires: adresses.map((a) => a.email),
    joursAvant: rap?.joursAvant ?? [],
    joursSilencieux: rap?.joursSilencieux ?? [],
    joursCantine: TOUS_LES_JOURS.filter((j) => !(rap?.joursSansCantine ?? []).includes(j)),
    joursMatin: rap?.joursMatin ?? [],
    joursSoir: rap?.joursSoir ?? [],
    pauseSemaine: rap?.pauseSemaine ?? null,
  };
}

/**
 * Les reglages de surveillance d'une famille, tels que `fenetresPour` les
 * attend. Charges a part de `chargerReglages`, qui sert l'affichage.
 */
async function surveillanceDe(parentId: string): Promise<ReglagesSurveillance> {
  const [rap] = await db
    .select({
      joursAvant: rappels.joursAvant,
      joursSansCantine: rappels.joursSansCantine,
      joursMatin: rappels.joursMatin,
      joursSoir: rappels.joursSoir,
      pauseSemaine: rappels.pauseSemaine,
    })
    .from(rappels)
    .where(eq(rappels.parentId, parentId));
  return {
    joursAvant: rap?.joursAvant ?? [],
    joursSansCantine: rap?.joursSansCantine ?? [],
    joursMatin: rap?.joursMatin ?? [],
    joursSoir: rap?.joursSoir ?? [],
    pauseSemaine: rap?.pauseSemaine ?? null,
  };
}

/**
 * Les fenetres d'une verification a la demande.
 *
 * On force le regard sur la cantine — `joursAvant` ramene au jour meme, pause
 * ignoree — parce que le parent qui clique veut justement voir l'etat de sa
 * semaine, quel que soit le jour et meme s'il vient de demander le silence.
 * Les jours decoches, eux, restent appliques : l'ecran doit montrer ce que le
 * service fera vraiment.
 */
function fenetresDeControle(aujourdhui: Date, reglages: ReglagesSurveillance) {
  const restants = calculerRestants(aujourdhui, prochaineEcheance(aujourdhui));
  return fenetresPour({
    aujourdhui,
    exclusions: exclusionsDepuisEnv(process.env),
    reglages: { ...reglages, joursAvant: [restants], pauseSemaine: null },
  });
}

/**
 * Enregistre les identifiants apres les avoir eprouves contre le portail.
 *
 * Valider tout de suite evite de decouvrir l'echec au premier cron, quand le
 * parent croit deja etre couvert. Le message renvoye est celui du portail
 * lui-meme ("Mauvais email et/ou mot de passe.").
 */
export async function enregistrerIdentifiants(
  parentId: string,
  portailEmail: string,
  motDePasse: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const cfg = configDepuisEnv(process.env, { email: portailEmail, password: motDePasse });

  try {
    const aujourdhui = aujourdhuiParis();
    // La cantine du jour suffit a prouver que les identifiants passent : une
    // seule fenetre, donc une seule requete.
    await reessayer(() =>
      verifierParent(cfg, {
        aujourdhui,
        fenetres: fenetresDeControle(aujourdhui, { joursAvant: [], joursSansCantine: [], joursMatin: [], joursSoir: [], pauseSemaine: null }),
      }),
    );
  } catch (e) {
    const erreur = e as Error;
    if (erreur instanceof ErreurIdentifiants) {
      return { ok: false, message: erreur.messagePortail ?? "Identifiants refuses par le portail." };
    }
    return {
      ok: false,
      message: `Le portail n'a pas repondu : ${erreur.message}. Vos identifiants ne sont pas en cause, reessayez plus tard.`,
    };
  }

  const valeurs = {
    portailEmail,
    mdpChiffre: chiffrer(motDePasse, parentId),
    cleVersion: VERSION_CLE_COURANTE,
    verifieLe: new Date(),
    echecsConsecutifs: 0,
    derniereErreur: null,
    alerteEchecLe: null,
  };
  await db
    .insert(identifiantsPortail)
    .values({ parentId, ...valeurs })
    .onConflictDoUpdate({ target: identifiantsPortail.parentId, set: valeurs });

  // Des identifiants a nouveau valides reactivent un compte suspendu.
  await db.update(parents).set({ actif: true }).where(eq(parents.id, parentId));
  return { ok: true };
}

export async function enregistrerDestinataires(parentId: string, emails: string[]): Promise<void> {
  const propres = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  await db.delete(destinataires).where(eq(destinataires.parentId, parentId));
  if (propres.length) {
    await db.insert(destinataires).values(propres.map((email) => ({ parentId, email })));
  }
}

/**
 * @param jours          jours ou verifier (0 = lundi, dernier jour)
 * @param confirmations  parmi ceux-ci, ceux ou ecrire meme si tout est reserve
 */
export async function enregistrerRappels(
  parentId: string,
  jours: number[],
  confirmations: number[],
): Promise<void> {
  const valide = (n: number) => Number.isInteger(n) && n >= 0 && n <= 6;
  const joursAvant = [...new Set(jours.filter(valide))].sort((a, b) => a - b);
  // Stocke en negatif : la liste vide vaut "confirmer partout", donc ajouter un
  // jour de rappel active la confirmation sans avoir a y penser.
  const joursSilencieux = joursAvant.filter((n) => !confirmations.includes(n));

  await db
    .insert(rappels)
    .values({ parentId, joursAvant, joursSilencieux })
    .onConflictDoUpdate({ target: rappels.parentId, set: { joursAvant, joursSilencieux } });
}

/**
 * Ce que l'on surveille, jour de semaine par jour de semaine (0 = lundi).
 *
 * L'ecran raisonne en positif — on coche ce que l'on veut surveiller — mais la
 * cantine est stockee en negatif, pour que la liste vide, donc le defaut,
 * vaille « alerter tous les jours ». Le periscolaire garde le positif, ou le
 * defaut sur est l'inverse : on ne peut pas alerter sur un service que la
 * famille n'utilise pas.
 */
export async function enregistrerSurveillance(
  parentId: string,
  { cantine, matin, soir }: { cantine: number[]; matin: number[]; soir: number[] },
): Promise<void> {
  const propre = (jours: number[]) =>
    [...new Set(jours.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);

  const joursSansCantine = TOUS_LES_JOURS.filter((j) => !propre(cantine).includes(j));
  const valeurs = {
    joursSansCantine,
    joursMatin: propre(matin),
    joursSoir: propre(soir),
  };
  await db
    .insert(rappels)
    .values({ parentId, ...valeurs })
    .onConflictDoUpdate({ target: rappels.parentId, set: valeurs });
}

/**
 * « Pas de cantine cette semaine ».
 *
 * On stocke la semaine visee et non une date de fin : quand l'echeance passe,
 * la semaine visee change, la valeur ne correspond plus et la cantine reprend
 * seule. Rien a purger, et recliquer est sans effet.
 */
export async function mettreEnPause(parentId: string, semaine: string): Promise<void> {
  await db
    .insert(rappels)
    .values({ parentId, pauseSemaine: semaine })
    .onConflictDoUpdate({ target: rappels.parentId, set: { pauseSemaine: semaine } });
}

export async function reprendreAlertes(parentId: string): Promise<void> {
  await db.update(rappels).set({ pauseSemaine: null }).where(eq(rappels.parentId, parentId));
}

/** La semaine que le bouton de pause ferait taire si on cliquait maintenant. */
export const semaineAMettreEnPause = (aujourdhui: Date): string =>
  iso(semaineVisee(prochaineEcheance(aujourdhui)));

export type Apercu = {
  semaine: string;
  echeance: string;
  joursRestants: number;
  reserves: number;
  manquants: { date: string; enfant: string }[];
  /** Ce qu'il manque cote garderie, avec le moment concerne. */
  periscolaire: { date: string; enfant: string; moment: string }[];
  /**
   * Jours actionnables qu'un reglage a ecartes. Les montrer est ce qui rend un
   * reglage trop restrictif detectable depuis l'ecran de verification.
   */
  ecartes: { date: string; enfant: string }[];
  /** Surveillances demandees qui n'existent pas sur ce portail. */
  absentes: string[];
  /** Surveillances dont la fenetre arrive apres l'echeance reelle du portail. */
  depassees: string[];
  /**
   * Ni repas reserve, ni repas a reserver : le portail ne propose rien sur
   * cette fenetre (vacances, hors annee scolaire). Meme distinction que
   * `decider` — sans elle, l'ecran ou le parent verifie que le service marche
   * lui annoncerait une semaine couverte pour zero repas.
   */
  rienAVerifier: boolean;
  /** Codes d'etat hors liste blanche, traites comme non reserves. Cf. ETATS_RESERVES. */
  inconnus: string[];
};

/**
 * Verification a la demande, sans envoyer de mail : le parent voit tout de
 * suite si sa configuration fonctionne, ce qui compense l'absence de reessai
 * automatique du cron quotidien.
 */
export async function verifierMaintenant(
  parentId: string,
): Promise<{ ok: true; apercu: Apercu } | { ok: false; message: string }> {
  const [ids] = await db
    .select({
      portailEmail: identifiantsPortail.portailEmail,
      mdpChiffre: identifiantsPortail.mdpChiffre,
    })
    .from(identifiantsPortail)
    .where(eq(identifiantsPortail.parentId, parentId));

  if (!ids) return { ok: false, message: "Aucun identifiant enregistre." };

  const { dechiffrer } = await import("../crypto.ts");
  const cfg = configDepuisEnv(process.env, {
    email: ids.portailEmail,
    password: dechiffrer(ids.mdpChiffre, parentId),
  });

  try {
    const aujourdhui = aujourdhuiParis();
    const fenetres = fenetresDeControle(aujourdhui, await surveillanceDe(parentId));
    const r = await reessayer(() => verifierParent(cfg, { aujourdhui, fenetres }));
    await db
      .update(identifiantsPortail)
      .set({ verifieLe: new Date(), echecsConsecutifs: 0, derniereErreur: null, alerteEchecLe: null })
      .where(eq(identifiantsPortail.parentId, parentId));
    return {
      ok: true,
      apercu: {
        semaine: iso(r.semaine),
        echeance: iso(r.echeance),
        joursRestants: r.joursRestants,
        reserves: r.analyse.reserves.length,
        manquants: r.analyse.manquants
          .filter((m) => m.cle === "cantine")
          .map((m) => ({ date: iso(m.date), enfant: m.enfant })),
        periscolaire: r.analyse.manquants
          .filter((m) => m.cle !== "cantine")
          .map((m) => ({
            date: iso(m.date),
            enfant: m.enfant,
            moment: LIBELLES_SURVEILLANCE[m.cle],
          })),
        ecartes: ecartesParReglages(r.analyse).map((c) => ({
          date: iso(c.date),
          enfant: c.enfant,
        })),
        absentes: r.analyse.absentes.map((c) => LIBELLES_SURVEILLANCE[c]),
        depassees: r.analyse.fenetresDepassees.map((c) => LIBELLES_SURVEILLANCE[c]),
        rienAVerifier: r.analyse.reserves.length === 0 && r.analyse.manquants.length === 0,
        inconnus: r.analyse.inconnus,
      },
    };
  } catch (e) {
    const erreur = e as Error;
    return {
      ok: false,
      message:
        erreur instanceof ErreurIdentifiants
          ? (erreur.messagePortail ?? erreur.message)
          : erreur.message,
    };
  }
}

/** Prefixe d'objet du mail de test. Doit rester reconnaissable d'un coup d'oeil. */
const PREFIXE_TEST = "[Test] ";

export type ResultatTest =
  | { ok: true; envoye: true; objet: string; destinataire: string }
  /** La date choisie ne declencherait aucun message : c'est aussi un resultat. */
  | { ok: true; envoye: false; raison: string }
  | { ok: false; message: string };

/**
 * Envoie a une seule adresse le message qui partirait a une date donnee.
 *
 * Sert a voir le mail reel dans sa boite plutot qu'a l'imaginer : mise en page,
 * delivrabilite, rendu du client. La date choisie sert de « aujourd'hui », donc
 * elle determine l'echeance, la semaine visee et le passage en urgent — c'est
 * le seul moyen de voir le message de J-0 sans attendre le dimanche soir.
 *
 * ⚠️ Simuler une date change la semaine EXAMINEE, pas l'etat du portail, qui
 * reste celui d'aujourd'hui. Une date passee ne rejoue pas l'historique.
 *
 * N'ecrit rien : ni ligne dans `envois` — elle tient lieu de verrou
 * anti-doublon, la consommer ferait taire le vrai rappel du jour — ni compteur
 * d'echecs, ni date de verification. Un test ne doit pas deplacer l'etat du
 * service.
 */
export async function envoyerMailTest(
  parentId: string,
  { date, destinataire }: { date: Date; destinataire: string },
): Promise<ResultatTest> {
  const [ids] = await db
    .select({
      portailEmail: identifiantsPortail.portailEmail,
      mdpChiffre: identifiantsPortail.mdpChiffre,
    })
    .from(identifiantsPortail)
    .where(eq(identifiantsPortail.parentId, parentId));

  if (!ids) return { ok: false, message: "Aucun identifiant enregistre." };

  // Le destinataire est choisi dans une liste, jamais saisi : l'app enverrait
  // sinon un mail a une adresse arbitraire sur simple requete authentifiee.
  if (!(await destinatairesAutorises(parentId)).includes(destinataire)) {
    return { ok: false, message: "Cette adresse ne fait pas partie de vos destinataires." };
  }

  const [rap] = await db
    .select({ joursSilencieux: rappels.joursSilencieux })
    .from(rappels)
    .where(eq(rappels.parentId, parentId));
  const surveillance = await surveillanceDe(parentId);

  const { dechiffrer } = await import("../crypto.ts");
  const cfg = configDepuisEnv(process.env, {
    email: ids.portailEmail,
    password: dechiffrer(ids.mdpChiffre, parentId),
  });

  let r;
  try {
    // La date choisie sert de « aujourd'hui » : elle determine l'echeance, la
    // semaine visee et le passage en urgent. On force le regard sur la cantine,
    // sans quoi choisir une date hors des jours de rappel ne montrerait rien.
    r = await reessayer(() =>
      verifierParent(cfg, { aujourdhui: date, fenetres: fenetresDeControle(date, surveillance) }),
    );
  } catch (e) {
    const erreur = e as Error;
    return {
      ok: false,
      message:
        erreur instanceof ErreurIdentifiants
          ? (erreur.messagePortail ?? erreur.message)
          : erreur.message,
    };
  }

  const manquants = r.analyse.manquants.length;
  const reserves = r.analyse.reserves.length;
  const decision = decider({
    manquants,
    reserves,
    // Le regard sur la cantine est force ci-dessus : ce jour compte donc comme
    // un jour de nouvelles, sinon le test ne rendrait jamais de confirmation.
    jourDeNouvelles: true,
    joursRestants: r.joursRestants,
    joursSilencieux: rap?.joursSilencieux ?? [],
  });

  if (decision === "silence") {
    return {
      ok: true,
      envoye: false,
      raison:
        manquants === 0 && reserves === 0
          ? `Au ${iso(date)}, le portail ne propose aucun repas sur la semaine du ` +
            `${iso(r.semaine)} : vacances ou hors annee scolaire. Aucun message ne partirait.`
          : `Au ${iso(date)}, tout est reserve et ce jour est marque sans confirmation ` +
            "dans vos reglages. Aucun message ne partirait.",
    };
  }

  const liens = liensPour(parentId, iso(r.semaine));
  const manquantsCantine = r.analyse.manquants.filter((m) => m.cle === "cantine");
  const manquantsPerisco = r.analyse.manquants.filter((m) => m.cle !== "cantine");
  const message =
    decision === "rappel"
      ? mailRappel({
          aujourdhui: date,
          cantine: {
            manquants: manquantsCantine,
            semaine: r.semaine,
            echeance: r.echeance,
            joursRestants: r.joursRestants,
          },
          periscolaire: manquantsPerisco,
          liens,
        })
      : mailConfirmation({
          cantine: {
            semaine: r.semaine,
            echeance: r.echeance,
            reserves: r.analyse.reserves.filter((x) => x.cle === "cantine").length,
          },
          periscolaire: null,
          liens,
        });

  const objet = `${PREFIXE_TEST}${message.objet}`;
  try {
    await expediteur()({
      destinataires: [destinataire],
      objet,
      corps: message.texte,
      html: message.html,
    });
  } catch (e) {
    return { ok: false, message: `Envoi impossible : ${(e as Error).message}` };
  }

  return { ok: true, envoye: true, objet, destinataire };
}

/** Les adresses vers lesquelles un test peut partir : celles du foyer, sinon le compte. */
export async function destinatairesAutorises(parentId: string): Promise<string[]> {
  const lignes = await db
    .select({ email: destinataires.email })
    .from(destinataires)
    .where(eq(destinataires.parentId, parentId));
  if (lignes.length) return lignes.map((l) => l.email);

  const [parent] = await db
    .select({ email: parents.email })
    .from(parents)
    .where(eq(parents.id, parentId));
  return parent ? [parent.email] : [];
}
