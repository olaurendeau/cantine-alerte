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
};

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
    .select({ joursAvant: rappels.joursAvant, joursSilencieux: rappels.joursSilencieux })
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
  };
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
    await reessayer(() => verifierParent(cfg, { aujourdhui: aujourdhuiParis() }));
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

export type Apercu = {
  semaine: string;
  echeance: string;
  joursRestants: number;
  reserves: number;
  manquants: { date: string; enfant: string }[];
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
    const r = await reessayer(() => verifierParent(cfg, { aujourdhui: aujourdhuiParis() }));
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
        manquants: r.analyse.manquants.map((m) => ({ date: iso(m.date), enfant: m.enfant })),
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

  const { dechiffrer } = await import("../crypto.ts");
  const cfg = configDepuisEnv(process.env, {
    email: ids.portailEmail,
    password: dechiffrer(ids.mdpChiffre, parentId),
  });

  let r;
  try {
    r = await reessayer(() => verifierParent(cfg, { aujourdhui: date }));
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

  const liens = liensPour(parentId);
  const message =
    decision === "rappel"
      ? mailRappel({
          manquants: r.analyse.manquants,
          semaine: r.semaine,
          echeance: r.echeance,
          joursRestants: r.joursRestants,
          urgent: r.joursRestants === 0,
          liens,
        })
      : mailConfirmation({
          semaine: r.semaine,
          echeance: r.echeance,
          reserves,
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
