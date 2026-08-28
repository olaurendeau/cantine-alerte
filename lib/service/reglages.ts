import { eq } from "drizzle-orm";
import { chiffrer, VERSION_CLE_COURANTE } from "../crypto.ts";
import { db } from "../db/index.ts";
import { destinataires, identifiantsPortail, parents, rappels } from "../db/schema.ts";
import {
  ErreurIdentifiants,
  aujourdhuiParis,
  configDepuisEnv,
  iso,
  verifierParent,
} from "../portail/index.ts";
import { reessayer } from "../reessayer.ts";

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
