import { and, eq, sql } from "drizzle-orm";
import { dechiffrer } from "../crypto.ts";
import { db } from "../db/index.ts";
import { destinataires, envois, identifiantsPortail, parents, rappels } from "../db/schema.ts";
import { urlDesabonnement } from "../auth/desabonnement.ts";
import { expediteur, type Expediteur } from "../mail/index.ts";
import {
  mailConfirmation,
  mailEchecAdmin,
  mailEchecParent,
  mailRappel,
  type Liens,
} from "../mail/messages.ts";
import {
  ErreurIdentifiants,
  PORTAIL_DEFAUT,
  aujourdhuiParis,
  configDepuisEnv,
  iso,
  joursRestants as calculerRestants,
  prochaineEcheance,
  semaineVisee,
  urlPortail,
  verifierParent,
} from "../portail/index.ts";
import { decider } from "./decision.ts";
import type { Logger } from "../portail/types.ts";
import { silencieux } from "../portail/types.ts";
import { reessayer } from "../reessayer.ts";
import { urlPublique } from "../url-publique.ts";

const SEUIL_DESACTIVATION = 3;

/**
 * Liens du pied de page. Ne prend pas la config du portail en parametre : ils
 * doivent aussi etre calculables quand le dechiffrement des identifiants vient
 * d'echouer, cas ou l'on n'a justement pas de config.
 */
const liensPour = (parentId: string): Liens => ({
  reservation: urlPortail({ portail: process.env.CANTINE_PORTAIL ?? PORTAIL_DEFAUT }),
  reglages: `${urlPublique()}/reglages`,
  desabonnement: urlDesabonnement(parentId),
});
const PAUSE_ENTRE_COMPTES_MS = Number(process.env.CANTINE_PAUSE_MS ?? 3000);

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type StatutParent =
  | "notifie"
  | "confirme"
  | "rien_a_signaler"
  | "deja_notifie"
  | "identifiants_invalides"
  | "echec_technique";

export type ResultatParent = {
  parentId: string;
  email: string;
  statut: StatutParent;
  detail?: string;
  manquants?: number;
};

export type ResultatCron = {
  aujourdhui: string;
  echeance: string;
  semaineVisee: string;
  joursRestants: number;
  traites: ResultatParent[];
};

/** Adresses de l'administrateur, pour les alertes d'echec. */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const estAdmin = (email: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  adminEmails(env).includes(email.trim().toLowerCase());

/**
 * Un cycle de rappel complet.
 *
 * On ne traite que les parents dont la liste `jours_avant` contient le nombre
 * de jours restants du jour : c'est ce qui fait qu'une execution quotidienne
 * unique suffit a servir toutes les preferences de rappel.
 */
export async function executerCron({
  maintenant = new Date(),
  trace = silencieux,
  expedier = expediteur(),
}: { maintenant?: Date; trace?: Logger; expedier?: Expediteur } = {}): Promise<ResultatCron> {
  const aujourdhui = aujourdhuiParis(maintenant);
  const echeance = prochaineEcheance(aujourdhui);
  const semaine = semaineVisee(echeance);
  const restants = calculerRestants(aujourdhui, echeance);

  trace(
    `cron ${iso(aujourdhui)} : echeance ${iso(echeance)} (J-${restants}), ` +
      `semaine visee ${iso(semaine)}`,
  );

  const dus = await db
    .select({
      parentId: parents.id,
      email: parents.email,
      portailEmail: identifiantsPortail.portailEmail,
      mdpChiffre: identifiantsPortail.mdpChiffre,
      echecs: identifiantsPortail.echecsConsecutifs,
      alerteEchecLe: identifiantsPortail.alerteEchecLe,
      joursSilencieux: rappels.joursSilencieux,
    })
    .from(parents)
    .innerJoin(identifiantsPortail, eq(identifiantsPortail.parentId, parents.id))
    .innerJoin(rappels, eq(rappels.parentId, parents.id))
    .where(
      and(
        eq(parents.actif, true),
        sql`${rappels.joursAvant} @> ARRAY[${restants}]::integer[]`,
      ),
    );

  trace(`${dus.length} compte(s) a traiter aujourd'hui`);

  const traites: ResultatParent[] = [];
  for (const [i, parent] of dus.entries()) {
    // Le portail limite le debit par adresse IP : enchainer les connexions sans
    // pause finit en 429, et ce 429 frappe alors des comptes valides. On espace
    // donc les familles. A 3 s l'intervalle, on tient une cinquantaine de
    // comptes dans les 300 s d'une fonction Vercel.
    if (i > 0) await pause(PAUSE_ENTRE_COMPTES_MS);
    traites.push(
      await traiterParent(parent, { aujourdhui, semaine, echeance, restants, trace, expedier }),
    );
  }
  return {
    aujourdhui: iso(aujourdhui),
    echeance: iso(echeance),
    semaineVisee: iso(semaine),
    joursRestants: restants,
    traites,
  };
}

type Compte = {
  parentId: string;
  email: string;
  portailEmail: string;
  mdpChiffre: string;
  echecs: number;
  alerteEchecLe: Date | null;
  joursSilencieux: number[];
};

async function traiterParent(
  compte: Compte,
  ctx: {
    aujourdhui: Date;
    semaine: Date;
    echeance: Date;
    restants: number;
    trace: Logger;
    expedier: Expediteur;
  },
): Promise<ResultatParent> {
  const base = { parentId: compte.parentId, email: compte.email };
  const adresses = await destinatairesDe(compte.parentId, compte.email);

  try {
    const cfg = configDepuisEnv(process.env, {
      email: compte.portailEmail,
      password: dechiffrer(compte.mdpChiffre, compte.parentId),
    });

    // Reessais sur panne du portail, jamais sur identifiants refuses.
    // On passe bien la date du jour : verifierParent en deduit lui-meme
    // l'echeance puis la semaine visee. Lui donner le lundi vise le ferait
    // repartir d'une echeance decalee d'une semaine.
    const resultat = await reessayer(
      () => verifierParent(cfg, { aujourdhui: ctx.aujourdhui, semaines: 1, trace: ctx.trace }),
      { trace: ctx.trace },
    );

    await succes(compte.parentId);

    const manquants = resultat.analyse.manquants.length;
    const decision = decider({
      manquants,
      joursRestants: ctx.restants,
      joursSilencieux: compte.joursSilencieux ?? [],
    });

    if (decision === "silence") {
      return { ...base, statut: "rien_a_signaler", manquants: 0 };
    }

    // L'anti-doublon est porte par la contrainte d'unicite : si l'insertion ne
    // rend aucune ligne, le message est deja parti et on n'envoie rien.
    const insere = await db
      .insert(envois)
      .values({
        parentId: compte.parentId,
        semaineVisee: iso(ctx.semaine),
        joursAvant: ctx.restants,
        type: decision,
      })
      .onConflictDoNothing()
      .returning({ id: envois.id });

    if (insere.length === 0) {
      return { ...base, statut: "deja_notifie", manquants };
    }

    const liens = liensPour(compte.parentId);
    const message =
      decision === "rappel"
        ? mailRappel({
            manquants: resultat.analyse.manquants,
            semaine: ctx.semaine,
            echeance: ctx.echeance,
            joursRestants: ctx.restants,
            // Urgent quand l'echeance tombe aujourd'hui : derniere occasion.
            urgent: ctx.restants === 0,
            liens,
          })
        : mailConfirmation({
            semaine: ctx.semaine,
            echeance: ctx.echeance,
            reserves: resultat.analyse.reserves.length,
            liens,
          });

    await ctx.expedier({
      destinataires: adresses,
      objet: message.objet,
      corps: message.texte,
      html: message.html,
    });
    return { ...base, statut: decision === "rappel" ? "notifie" : "confirme", manquants };
  } catch (e) {
    const erreur = e as Error;
    const invalides = erreur instanceof ErreurIdentifiants;
    const detail = invalides
      ? (erreur.messagePortail ?? erreur.message)
      : erreur.message;

    const echecs = await echec(compte.parentId, detail, invalides);
    await alerter(compte, adresses, { detail, invalides, echecs, expedier: ctx.expedier });

    return {
      ...base,
      statut: invalides ? "identifiants_invalides" : "echec_technique",
      detail,
    };
  }
}

/** Les destinataires configures, ou a defaut l'email du compte. */
async function destinatairesDe(parentId: string, secours: string): Promise<string[]> {
  const lignes = await db
    .select({ email: destinataires.email })
    .from(destinataires)
    .where(eq(destinataires.parentId, parentId));
  return lignes.length ? lignes.map((l) => l.email) : [secours];
}

async function succes(parentId: string) {
  await db
    .update(identifiantsPortail)
    .set({
      verifieLe: new Date(),
      echecsConsecutifs: 0,
      derniereErreur: null,
      // Remise a zero : on re-alertera si une nouvelle panne survient.
      alerteEchecLe: null,
    })
    .where(eq(identifiantsPortail.parentId, parentId));
}

async function echec(parentId: string, detail: string, invalides: boolean): Promise<number> {
  const [ligne] = await db
    .update(identifiantsPortail)
    .set({
      echecsConsecutifs: sql`${identifiantsPortail.echecsConsecutifs} + 1`,
      derniereErreur: detail.slice(0, 500),
    })
    .where(eq(identifiantsPortail.parentId, parentId))
    .returning({ echecs: identifiantsPortail.echecsConsecutifs });

  const echecs = ligne?.echecs ?? 1;
  // Ne desactiver que sur des identifiants refuses : seul le parent peut y
  // remedier, et insister risque de faire verrouiller son compte. Une panne
  // technique ou un throttling ne doit JAMAIS desactiver un compte valide,
  // sinon une indisponibilite du portail suffirait a couper le service pour
  // tout le monde.
  if (invalides && echecs >= SEUIL_DESACTIVATION) {
    await db.update(parents).set({ actif: false }).where(eq(parents.id, parentId));
  }
  return echecs;
}

/**
 * Previent le parent et l'administrateur. Une seule fois par serie d'echecs :
 * le compteur est remis a zero a la premiere reussite, donc une panne longue ne
 * genere pas un mail par jour.
 */
async function alerter(
  compte: Compte,
  adresses: string[],
  {
    detail,
    invalides,
    echecs,
    expedier,
  }: { detail: string; invalides: boolean; echecs: number; expedier: Expediteur },
) {
  if (compte.alerteEchecLe) return;

  const desactive = invalides && echecs >= SEUIL_DESACTIVATION;
  const parent = mailEchecParent({
    invalides,
    detail,
    echecs,
    seuil: SEUIL_DESACTIVATION,
    desactive,
    liens: liensPour(compte.parentId),
  });
  await expedier({
    destinataires: adresses,
    objet: parent.objet,
    corps: parent.texte,
    html: parent.html,
  });

  const admins = adminEmails();
  if (admins.length) {
    const admin = mailEchecAdmin({
      compte: compte.email,
      invalides,
      detail,
      echecs,
      desactive,
      objetParent: parent.objet,
    });
    await expedier({
      destinataires: admins,
      objet: admin.objet,
      corps: admin.texte,
      html: admin.html,
    });
  }

  await db
    .update(identifiantsPortail)
    .set({ alerteEchecLe: new Date() })
    .where(eq(identifiantsPortail.parentId, compte.parentId));
}
