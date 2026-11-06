import { eq } from "drizzle-orm";
import { chiffrer, dechiffrer, VERSION_CLE_COURANTE } from "../crypto.ts";
import { db } from "../db/index.ts";
import { associationsPortail, identifiantsPortail, parents } from "../db/schema.ts";
import {
  ErreurCodeRefuse,
  ErreurConnexionExpiree,
  ErreurIdentifiants,
  ErreurTemporaire,
  configDepuisEnv,
  demanderCode,
  nouvelleSession,
  validerCode,
  type PotExporte,
} from "../portail/index.ts";

/**
 * L'association d'un compte au portail depuis l'ecran de reglages, en deux
 * requetes : le portail envoie le code a la premiere, le parent le saisit a la
 * seconde, souvent un quart d'heure plus tard. En serverless rien ne survit
 * entre les deux : la connexion entamee est conservee, chiffree, dans
 * `associations_portail`. Plan : `docs/plans/appareil-de-confiance.md`.
 *
 * Le mot de passe saisi n'entre dans `identifiants_portail` qu'une fois le code
 * accepte : c'est cette acceptation qui prouve a la fois le mot de passe et
 * l'appareil.
 */

/** Le code vaut 60 min ; la session Laravel en tient 120. */
export const DUREE_ASSOCIATION_MS = 55 * 60_000;

/**
 * Une demande de code par parent toutes les 2 minutes. Chaque demande est une
 * connexion complete depuis l'IP du service — le throttling du portail est par
 * IP, donc partage par toutes les familles — et un mail de plus chez le parent.
 */
export const PLAFOND_REDEMANDE_MS = 2 * 60_000;

/** Ce que l'on conserve entre les deux temps. ⚠️ Secret de bout en bout : chiffre. */
export type EnAttente = {
  pot: PotExporte;
  jeton: string;
  referer: string;
  portailEmail: string;
  motDePasse: string;
};

export type Issue =
  /** Identifiants changes sur un compte deja associe : pas de code a saisir. */
  | { ok: true; etat: "enregistre" }
  | { ok: true; etat: "code_envoye" }
  | { ok: true; etat: "associe"; expireLe: Date | null }
  /**
   * `incident` : une erreur qui n'est la faute ni du parent ni d'un hoquet du
   * portail, a remonter a la supervision. Le message reste celui du parent ;
   * c'est l'appelant, cote `app/`, qui parle a Sentry.
   */
  | { ok: false; message: string; incident?: Error };

/** Le moment a partir duquel un nouveau code peut etre demande. Pure. */
export function redemandePossibleLe(demandeeLe: Date): Date {
  return new Date(demandeeLe.getTime() + PLAFOND_REDEMANDE_MS);
}

/** Le code tel que le parent l'a colle : espaces et tirets toleres. Pure. */
export function codePropre(saisi: string): string | null {
  const chiffres = saisi.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(chiffres) ? chiffres : null;
}

export function serialiser(attente: EnAttente, parentId: string): string {
  return chiffrer(JSON.stringify(attente), parentId);
}

export function relire(chiffree: string, parentId: string): EnAttente {
  return JSON.parse(dechiffrer(chiffree, parentId)) as EnAttente;
}

const PERIMEE = "La demande en cours n'est plus lisible. Saisissez vos identifiants pour recevoir un nouveau code.";

/**
 * La demande en cours, ou null si elle est illisible — typiquement apres une
 * rotation de `CANTINE_CLE_CHIFFREMENT`. On l'efface alors : elle ne servira
 * plus, et la laisser ferait echouer chaque tentative de la meme facon.
 */
async function relireOuOublier(chiffree: string, parentId: string): Promise<EnAttente | null> {
  try {
    return relire(chiffree, parentId);
  } catch {
    await oublier(parentId);
    return null;
  }
}

/** L'association en cours, sans rien dechiffrer : de quoi l'afficher. */
export async function associationEnCours(
  parentId: string,
  maintenant = new Date(),
): Promise<{ demandeeLe: Date; expireLe: Date } | null> {
  const [ligne] = await db
    .select({ demandeeLe: associationsPortail.demandeeLe, expireLe: associationsPortail.expireLe })
    .from(associationsPortail)
    .where(eq(associationsPortail.parentId, parentId));
  return ligne && ligne.expireLe > maintenant ? ligne : null;
}

async function oublier(parentId: string) {
  await db.delete(associationsPortail).where(eq(associationsPortail.parentId, parentId));
}

/**
 * Premier temps : mot de passe, puis arret sur la page du code. C'est a ce
 * moment que le portail envoie le code au parent.
 */
export async function demanderAssociation(
  parentId: string,
  portailEmail: string,
  motDePasse: string,
  maintenant = new Date(),
): Promise<Issue> {
  const [precedente] = await db
    .select({ demandeeLe: associationsPortail.demandeeLe })
    .from(associationsPortail)
    .where(eq(associationsPortail.parentId, parentId));
  if (precedente && redemandePossibleLe(precedente.demandeeLe) > maintenant) {
    return {
      ok: false,
      message:
        "Un code vient de vous être envoyé : il peut mettre une quinzaine de minutes à arriver. " +
        "Vous pourrez en redemander un dans deux minutes.",
    };
  }

  const cfg = configDepuisEnv(process.env, { email: portailEmail, password: motDePasse });
  const session = nouvelleSession();
  let demande: Awaited<ReturnType<typeof demanderCode>>;
  try {
    demande = await demanderCode(cfg, session);
  } catch (e) {
    return echecDemande(e as Error);
  }

  if (demande.etat === "connecte") {
    // Le portail n'a pas demande de code : la 2FA a disparu, ou a change de
    // forme. Le cycle, lui, exige toujours un appareil — il faut le savoir.
    return {
      ok: false,
      message:
        "Le portail a accepté la connexion sans demander de code : son fonctionnement a " +
        "changé. L'administrateur du service est prévenu.",
      incident: new Error("Association : le portail n'a pas demande de code 2FA."),
    };
  }

  const valeurs = {
    chiffree: serialiser(
      { pot: session.exporter(), ...demande.attente, portailEmail, motDePasse },
      parentId,
    ),
    demandeeLe: maintenant,
    expireLe: new Date(maintenant.getTime() + DUREE_ASSOCIATION_MS),
  };
  await db
    .insert(associationsPortail)
    .values({ parentId, ...valeurs })
    .onConflictDoUpdate({ target: associationsPortail.parentId, set: valeurs });
  return { ok: true, etat: "code_envoye" };
}

/** Redemande un code avec les identifiants deja saisis, sans les retaper. */
export async function renvoyerCode(parentId: string, maintenant = new Date()): Promise<Issue> {
  const [ligne] = await db
    .select({ chiffree: associationsPortail.chiffree })
    .from(associationsPortail)
    .where(eq(associationsPortail.parentId, parentId));
  if (!ligne) {
    return { ok: false, message: "Saisissez vos identifiants du portail pour recevoir un code." };
  }
  const attente = await relireOuOublier(ligne.chiffree, parentId);
  if (!attente) return { ok: false, message: PERIMEE };
  return demanderAssociation(parentId, attente.portailEmail, attente.motDePasse, maintenant);
}

function echecDemande(erreur: Error): Issue {
  if (erreur instanceof ErreurIdentifiants) {
    return { ok: false, message: erreur.messagePortail ?? "Identifiants refusés par le portail." };
  }
  if (erreur instanceof ErreurTemporaire) {
    return {
      ok: false,
      message:
        "Le portail ne répond pas pour l'instant. Vos identifiants ne sont pas en cause : " +
        "réessayez dans quelques minutes.",
    };
  }
  return {
    ok: false,
    message: "Le portail a répondu de façon inattendue. L'administrateur du service est prévenu.",
    incident: erreur,
  };
}

/**
 * Second temps : le code, dans la session reprise telle que la premiere
 * requete l'a laissee.
 */
export async function validerAssociation(
  parentId: string,
  saisi: string,
  maintenant = new Date(),
): Promise<Issue> {
  const code = codePropre(saisi);
  if (!code) return { ok: false, message: "Le code de vérification compte 6 chiffres." };

  const [ligne] = await db
    .select({ chiffree: associationsPortail.chiffree, expireLe: associationsPortail.expireLe })
    .from(associationsPortail)
    .where(eq(associationsPortail.parentId, parentId));
  if (!ligne) {
    return { ok: false, message: "Aucun code en attente : saisissez vos identifiants pour en recevoir un." };
  }
  if (ligne.expireLe <= maintenant) {
    await oublier(parentId);
    return { ok: false, message: "La demande a expiré. Saisissez vos identifiants pour recevoir un nouveau code." };
  }

  const attente = await relireOuOublier(ligne.chiffree, parentId);
  if (!attente) return { ok: false, message: PERIMEE };
  const cfg = configDepuisEnv(process.env, {
    email: attente.portailEmail,
    password: attente.motDePasse,
  });
  const session = nouvelleSession(undefined, { pot: attente.pot });

  let obtenu: Awaited<ReturnType<typeof validerCode>>;
  try {
    obtenu = await validerCode(cfg, session, attente, code);
  } catch (e) {
    if (e instanceof ErreurCodeRefuse) {
      // La connexion reste utilisable, avec le jeton de la page re-rendue et
      // les cookies que Laravel vient de reposer.
      await db
        .update(associationsPortail)
        .set({ chiffree: serialiser({ ...attente, ...e.attente, pot: session.exporter() }, parentId) })
        .where(eq(associationsPortail.parentId, parentId));
      return {
        ok: false,
        message:
          `Code refusé par le portail${e.messagePortail ? ` : ${e.messagePortail}` : ""}. ` +
          "Vérifiez que c'est le dernier code reçu.",
      };
    }
    if (e instanceof ErreurConnexionExpiree) {
      await oublier(parentId);
      return { ok: false, message: "La demande a expiré côté portail. Saisissez vos identifiants pour recevoir un nouveau code." };
    }
    if (e instanceof ErreurTemporaire) {
      return {
        ok: false,
        message: "Le portail ne répond pas pour l'instant. Réessayez dans quelques minutes : le code reste valable une heure.",
      };
    }
    // Code peut-etre consomme, session dans un etat inconnu : on repart de zero.
    await oublier(parentId);
    return {
      ok: false,
      message: "Le portail a répondu de façon inattendue. L'administrateur du service est prévenu.",
      incident: e as Error,
    };
  }

  // Une connexion complete vient de reussir : meme remise a zero qu'un
  // enregistrement d'identifiants, et un compte suspendu repart.
  const valeurs = {
    portailEmail: attente.portailEmail,
    mdpChiffre: chiffrer(attente.motDePasse, parentId),
    cleVersion: VERSION_CLE_COURANTE,
    appareilChiffre: chiffrer(obtenu.appareil.valeur, parentId),
    appareilExpireLe: obtenu.appareil.expireLe,
    verifieLe: maintenant,
    echecsConsecutifs: 0,
    refusConsecutifs: 0,
    derniereErreur: null,
    alerteEchecLe: null,
  };
  await db
    .insert(identifiantsPortail)
    .values({ parentId, ...valeurs })
    .onConflictDoUpdate({ target: identifiantsPortail.parentId, set: valeurs });
  await db.update(parents).set({ actif: true }).where(eq(parents.id, parentId));
  await oublier(parentId);
  return { ok: true, etat: "associe", expireLe: obtenu.appareil.expireLe };
}
