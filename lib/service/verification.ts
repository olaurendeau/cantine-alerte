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
const PAUSE_DEFAUT_MS = 3000;

/**
 * Une valeur non numerique donnerait NaN, donc `setTimeout(NaN)` : la pause
 * anti-throttling disparaitrait sans un mot, et on ne le decouvrirait qu'en
 * voyant des 429 frapper des comptes valides.
 *
 * Une chaine vide est traitee comme une absence, et non comme un zero : c'est
 * ce que rend `Number("")`, et c'est le resultat normal d'un .env recopie puis
 * vide, ou d'une variable declaree sans valeur dans le tableau de bord Vercel.
 * Le defaut vaut mieux qu'une suppression silencieuse de la pause.
 */
export function pauseConfiguree(brut = process.env.CANTINE_PAUSE_MS): number {
  const texte = brut?.trim();
  if (!texte) return PAUSE_DEFAUT_MS;
  const n = Number(texte);
  return Number.isFinite(n) && n >= 0 ? n : PAUSE_DEFAUT_MS;
}

const PAUSE_ENTRE_COMPTES_MS = pauseConfiguree();

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type StatutParent =
  | "notifie"
  | "confirme"
  | "rien_a_signaler"
  /** Le portail ne propose rien sur la fenetre : vacances, hors annee scolaire. */
  | "rien_a_verifier"
  | "deja_notifie"
  /** Verification faite, message compose, mais l'expediteur n'a pas pu envoyer. */
  | "echec_envoi"
  | "identifiants_invalides"
  | "echec_technique";

export type ResultatParent = {
  parentId: string;
  email: string;
  statut: StatutParent;
  detail?: string;
  manquants?: number;
  /** Codes d'etat hors liste blanche, a classer. Cf. ETATS_RESERVES. */
  inconnus?: string[];
};

export type ResultatCron = {
  aujourdhui: string;
  echeance: string;
  semaineVisee: string;
  joursRestants: number;
  traites: ResultatParent[];
};

/**
 * Reduit a ce que les deux fonctions ci-dessous lisent vraiment. `env` est pris
 * en parametre plutot que lu directement : elles gardent l'acces a /admin, donc
 * doivent etre eprouvables sans toucher au process.
 */
type Env = Record<string, string | undefined>;

/** Adresses de l'administrateur, pour les alertes d'echec. */
export function adminEmails(env: Env = process.env): string[] {
  return (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const estAdmin = (email: string, env: Env = process.env): boolean =>
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
    try {
      traites.push(
        await traiterParent(parent, { aujourdhui, semaine, echeance, restants, trace, expedier }),
      );
    } catch (e) {
      // Filet de derniere instance. traiterParent gere deja ses erreurs, mais
      // s'il en echappait une (base indisponible le temps d'une requete, par
      // exemple) elle remonterait jusqu'a la route et interromprait le cycle :
      // tous les parents suivants perdraient leur rappel du jour en silence.
      const detail = (e as Error).message;
      trace(`parent ${parent.parentId} : erreur non rattrapee, on continue (${detail})`);
      traites.push({
        parentId: parent.parentId,
        email: parent.email,
        statut: "echec_technique",
        detail,
      });
    }
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
  // Initialise au repli : la branche d'erreur a besoin d'adresses pour prevenir
  // le parent, y compris quand c'est la lecture des destinataires qui a echoue.
  let adresses = [compte.email];

  try {
    adresses = await destinatairesDe(compte.parentId, compte.email);

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

    const { inconnus } = resultat.analyse;
    if (inconnus.length) {
      // Traites comme non reserves, donc sans risque de rappel manquant, mais
      // a classer dans ETATS_RESERVES ou ETATS_NON_RESERVES. Le CLI le signale
      // depuis toujours ; le cron est le seul a tourner tous les jours.
      ctx.trace(
        `parent ${compte.parentId} : etat(s) non repertorie(s) ${inconnus.join(", ")}, ` +
          "traite(s) comme non reserve(s)",
      );
    }

    const manquants = resultat.analyse.manquants.length;
    const reserves = resultat.analyse.reserves.length;
    const decision = decider({
      manquants,
      reserves,
      joursRestants: ctx.restants,
      joursSilencieux: compte.joursSilencieux ?? [],
    });

    if (decision === "silence") {
      // Rien a reserver et rien de reserve : periode fermee cote portail. Le
      // distinguer de "tout est reserve" evite d'annoncer au parent une semaine
      // couverte pendant les vacances, et rend le cas lisible dans les logs.
      const statut = manquants === 0 && reserves === 0 ? "rien_a_verifier" : "rien_a_signaler";
      return { ...base, statut, manquants: 0, ...(inconnus.length ? { inconnus } : {}) };
    }

    // Une confirmation ne doit pas suivre un rappel deja parti le meme jour
    // pour la meme semaine : le parent qui vient de reserver recevrait, trois
    // heures apres son rappel, un second message lui annoncant que tout va
    // bien. La cle d'unicite ne l'en empeche pas, puisque `type` en fait
    // partie — c'est justement ce qui permet au rappel de passer apres une
    // confirmation, le sens qui, lui, rattrape une annulation de derniere
    // minute.
    if (decision === "confirmation") {
      const [rappelParti] = await db
        .select({ id: envois.id })
        .from(envois)
        .where(
          and(
            eq(envois.parentId, compte.parentId),
            eq(envois.semaineVisee, iso(ctx.semaine)),
            eq(envois.joursAvant, ctx.restants),
            eq(envois.type, "rappel"),
          ),
        )
        .limit(1);
      if (rappelParti) return { ...base, statut: "deja_notifie", manquants };
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

    try {
      await ctx.expedier({
        destinataires: adresses,
        objet: message.objet,
        corps: message.texte,
        html: message.html,
      });
    } catch (e) {
      // La ligne d'envoi a ete posee AVANT l'expedition : c'est elle qui tient
      // lieu de verrou anti-doublon. L'envoi ayant echoue, il faut la liberer,
      // sinon le rejeu du filet la verrait et conclurait que le message est
      // deja parti. Une panne passagere de l'expediteur deviendrait un rappel
      // definitivement perdu — le seul echec vraiment grave de ce service.
      try {
        await db.delete(envois).where(eq(envois.id, insere[0].id));
      } catch (menage) {
        ctx.trace(
          `parent ${compte.parentId} : creneau d'envoi non libere apres echec ` +
            `(${(menage as Error).message})`,
        );
      }
      // Ne pas repasser par la branche d'erreur du portail. Celui-ci a
      // parfaitement repondu et `succes()` vient de le consigner : y renvoyer
      // ecraserait ce succes par une "derniere erreur" mentionnant l'expediteur,
      // afficherait au parent une panne du portail qui n'existe pas, et surtout
      // remettrait `alerte_echec_le` a zero a chaque cycle — donc une alerte par
      // jour au lieu d'une par serie. Prevenir le parent par mail n'aurait de
      // toute facon aucune chance d'aboutir : c'est l'expediteur qui est en
      // panne. Le statut remonte dans le resume du cron et dans les journaux.
      const echecEnvoi = (e as Error).message;
      ctx.trace(`parent ${compte.parentId} : expedition impossible (${echecEnvoi})`);
      return { ...base, statut: "echec_envoi", manquants, detail: echecEnvoi };
    }

    return {
      ...base,
      statut: decision === "rappel" ? "notifie" : "confirme",
      manquants,
      ...(inconnus.length ? { inconnus } : {}),
    };
  } catch (e) {
    const erreur = e as Error;
    const invalides = erreur instanceof ErreurIdentifiants;
    const detail = invalides
      ? (erreur.messagePortail ?? erreur.message)
      : erreur.message;

    const echecs = await echec(compte.parentId, detail, invalides);
    await alerter(compte, adresses, {
      detail,
      invalides,
      echecs,
      expedier: ctx.expedier,
      trace: ctx.trace,
    });

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
 *
 * Entierement defensif : on est deja dans la branche d'erreur, et cette
 * fonction s'execute pour chaque famille en echec. Une exception qui en
 * sortirait — expediteur en panne, ce qui est justement une cause frequente
 * d'echec — interromprait le cycle et priverait de rappel toutes les familles
 * suivantes. Un mail d'alerte perdu est benin ; un rappel perdu ne l'est pas.
 */
async function alerter(
  compte: Compte,
  adresses: string[],
  {
    detail,
    invalides,
    echecs,
    expedier,
    trace,
  }: {
    detail: string;
    invalides: boolean;
    echecs: number;
    expedier: Expediteur;
    trace: Logger;
  },
) {
  if (compte.alerteEchecLe) return;

  const tenter = async (quoi: string, envoi: () => Promise<void>): Promise<boolean> => {
    try {
      await envoi();
      return true;
    } catch (e) {
      trace(`alerte ${quoi} non envoyee (${(e as Error).message})`);
      return false;
    }
  };

  const desactive = invalides && echecs >= SEUIL_DESACTIVATION;
  const parent = mailEchecParent({
    invalides,
    detail,
    echecs,
    seuil: SEUIL_DESACTIVATION,
    desactive,
    liens: liensPour(compte.parentId),
  });
  const prevenu = await tenter("parent", () =>
    expedier({
      destinataires: adresses,
      objet: parent.objet,
      corps: parent.texte,
      html: parent.html,
    }),
  );

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
    await tenter("admin", () =>
      expedier({
        destinataires: admins,
        objet: admin.objet,
        corps: admin.texte,
        html: admin.html,
      }),
    );
  }

  // Le drapeau dit "le parent a ete prevenu". Ne le poser que si c'est vrai :
  // sinon un expediteur en panne aujourd'hui ferait taire l'alerte pour toute
  // la serie d'echecs, y compris quand l'envoi redeviendra possible demain.
  if (!prevenu) return;

  try {
    await db
      .update(identifiantsPortail)
      .set({ alerteEchecLe: new Date() })
      .where(eq(identifiantsPortail.parentId, compte.parentId));
  } catch (e) {
    trace(`marquage de l'alerte impossible (${(e as Error).message})`);
  }
}
