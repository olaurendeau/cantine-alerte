import { and, eq, inArray, sql } from "drizzle-orm";
import { dechiffrer } from "../crypto.ts";
import { db } from "../db/index.ts";
import { destinataires, envois, identifiantsPortail, parents, rappels } from "../db/schema.ts";
import { urlDesabonnement } from "../auth/desabonnement.ts";
import { urlPause } from "../auth/pause.ts";
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
  ajouter,
  aujourdhuiParis,
  configDepuisEnv,
  exclusionsDepuisEnv,
  fenetresPour,
  iso,
  jourSemaine,
  joursRestants as calculerRestants,
  prochaineEcheance,
  semaineVisee,
  urlPortail,
  verifierParent,
  type Fenetre,
} from "../portail/index.ts";
import { decider } from "./decision.ts";
import type { CleSurveillance, Logger } from "../portail/types.ts";
import { silencieux } from "../portail/types.ts";
import { reessayer } from "../reessayer.ts";
import { urlPublique } from "../url-publique.ts";

const SEUIL_DESACTIVATION = 3;

/**
 * Liens du pied de page. Ne prend pas la config du portail en parametre : ils
 * doivent aussi etre calculables quand le dechiffrement des identifiants vient
 * d'echouer, cas ou l'on n'a justement pas de config.
 */
export const liensPour = (parentId: string, semaine?: string): Liens => ({
  reservation: urlPortail({ portail: process.env.CANTINE_PORTAIL ?? PORTAIL_DEFAUT }),
  reglages: `${urlPublique()}/reglages`,
  desabonnement: urlDesabonnement(parentId),
  // Le jeton porte la semaine : un lien de la semaine derniere ne peut pas
  // faire taire celle en cours. Absent quand on ne sait pas de quelle semaine
  // on parle — les mails d'echec, par exemple.
  ...(semaine ? { pause: urlPause(parentId, semaine) } : {}),
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

/**
 * Budget d'un cycle, sous le `maxDuration = 300` de la fonction Vercel.
 *
 * Sans lui, la plateforme coupe la fonction en plein vol : les familles de fin
 * de liste perdent leur rappel du jour sans laisser la moindre trace. On
 * s'arrete donc AVANT, en le disant — une famille non traitee reste une alerte
 * potentiellement perdue, elle doit se voir dans le resume et les journaux.
 *
 * La marge couvre le pire cas d'une derniere famille engagee : budget de
 * session de 45 s plus les reessais.
 */
const BUDGET_CYCLE_MS = 230_000;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type StatutParent =
  | "notifie"
  | "confirme"
  | "rien_a_signaler"
  /** Le portail ne propose rien sur la fenetre : vacances, hors annee scolaire. */
  | "rien_a_verifier"
  | "deja_notifie"
  /** Le parent a demande le silence sur la cantine pour cette semaine visee. */
  | "en_pause"
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
  /** Surveillances demandees qui n'existent pas sur ce portail. */
  absentes?: CleSurveillance[];
  /** Surveillances dont la fenetre calculee arrive apres l'echeance reelle. */
  depassees?: CleSurveillance[];
};

export type ResultatCron = {
  aujourdhui: string;
  echeance: string;
  semaineVisee: string;
  joursRestants: number;
  traites: ResultatParent[];
  /**
   * Familles jamais examinees, faute de temps. Zero est le cas normal ; tout
   * autre chiffre signale que le cycle ne tient plus dans son budget.
   */
  nonTraites: number;
  /**
   * Duree du cycle et nombre de connexions au portail.
   *
   * Le periscolaire fait passer une famille qui l'active de deux jours sur sept
   * a sept jours sur sept : le plafond de 300 s d'une fonction Vercel, a trois
   * secondes de pause par famille, se rapproche sans rien dire. Ces deux
   * chiffres remontent dans le resume pour qu'on le voie venir.
   */
  dureeMs: number;
  interroges: number;
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
 * Une seule execution quotidienne sert toutes les preferences : le rappel de
 * cantine ne part que les jours choisis par la famille, tandis que le
 * periscolaire — qui se joue a deux jours — est regarde des qu'un jour attendu
 * tombe a J+1 ou J+2.
 */
export async function executerCron({
  maintenant = new Date(),
  trace = silencieux,
  expedier = expediteur(),
}: { maintenant?: Date; trace?: Logger; expedier?: Expediteur } = {}): Promise<ResultatCron> {
  const commence = Date.now();
  const aujourdhui = aujourdhuiParis(maintenant);
  const echeance = prochaineEcheance(aujourdhui);
  const semaine = semaineVisee(echeance);
  const restants = calculerRestants(aujourdhui, echeance);
  const exclusions = exclusionsDepuisEnv(process.env);

  trace(
    `cron ${iso(aujourdhui)} : echeance ${iso(echeance)} (J-${restants}), ` +
      `semaine visee ${iso(semaine)}`,
  );

  // La pause n'est PAS filtree ici : elle ne couvre que la cantine, et une
  // famille en pause reste interrogee pour son periscolaire. C'est
  // `fenetresPour` qui tranche, un cran plus bas.
  const dus = await db
    .select({
      parentId: parents.id,
      email: parents.email,
      portailEmail: identifiantsPortail.portailEmail,
      mdpChiffre: identifiantsPortail.mdpChiffre,
      echecs: identifiantsPortail.echecsConsecutifs,
      alerteEchecLe: identifiantsPortail.alerteEchecLe,
      joursAvant: rappels.joursAvant,
      joursSilencieux: rappels.joursSilencieux,
      joursSansCantine: rappels.joursSansCantine,
      joursMatin: rappels.joursMatin,
      joursSoir: rappels.joursSoir,
      pauseSemaine: rappels.pauseSemaine,
    })
    .from(parents)
    .innerJoin(identifiantsPortail, eq(identifiantsPortail.parentId, parents.id))
    .innerJoin(rappels, eq(rappels.parentId, parents.id))
    .where(
      and(
        eq(parents.actif, true),
        // `jours_avant` vide est l'interrupteur general pose par le lien de
        // desabonnement : plus aucun mail, periscolaire compris.
        sql`cardinality(${rappels.joursAvant}) > 0`,
        sql`(${rappels.joursAvant} @> ARRAY[${restants}]::integer[]
             OR cardinality(${rappels.joursMatin}) > 0
             OR cardinality(${rappels.joursSoir}) > 0)`,
      ),
    )
    // Les moins recemment verifiees d'abord. Sans ordre explicite, Postgres rend
    // une liste stable en pratique : la meme famille se retrouverait en queue a
    // chaque cycle, donc systematiquement sacrifiee quand le budget s'epuise —
    // et le filet de 19 h la couperait au meme endroit. `verifie_le` etant remis
    // a jour a chaque succes, une famille non traitee passe mecaniquement en
    // tete au cycle suivant.
    .orderBy(sql`${identifiantsPortail.verifieLe} ASC NULLS FIRST`);

  trace(`${dus.length} compte(s) candidat(s) aujourd'hui`);

  const traites: ResultatParent[] = [];
  let interroges = 0;
  let nonTraites = 0;
  for (const [rang, parent] of dus.entries()) {
    // On s'arrete net plutot que de se faire couper : le reste de la liste est
    // compte et remonte, au lieu de disparaitre en silence.
    if (Date.now() - commence > BUDGET_CYCLE_MS) {
      nonTraites = dus.length - rang;
      trace(
        `BUDGET EPUISE apres ${Date.now() - commence} ms : ${nonTraites} compte(s) non ` +
          "examine(s). Ils passeront en tete au prochain cycle, mais leur rappel du jour " +
          "est perdu si celui-ci etait le dernier.",
      );
      break;
    }

    const fenetres = fenetresPour({
      aujourdhui,
      exclusions,
      reglages: {
        joursAvant: parent.joursAvant ?? [],
        joursSansCantine: parent.joursSansCantine ?? [],
        joursMatin: parent.joursMatin ?? [],
        joursSoir: parent.joursSoir ?? [],
        pauseSemaine: parent.pauseSemaine,
      },
    });

    if (fenetres.length === 0) {
      // On distingue le silence demande du simple "rien a faire ce jour-la" :
      // le premier merite d'apparaitre au parent comme a l'exploitant, le
      // second remplirait le decompte de non-evenements.
      const jourDeNouvelles = (parent.joursAvant ?? []).includes(restants);
      if (jourDeNouvelles && parent.pauseSemaine === iso(semaine)) {
        traites.push({ parentId: parent.parentId, email: parent.email, statut: "en_pause" });
      }
      continue;
    }

    // Le portail limite le debit par adresse IP : enchainer les connexions sans
    // pause finit en 429, et ce 429 frappe alors des comptes valides. On espace
    // donc les familles reellement interrogees — pauser pour un compte qu'on
    // vient d'ecarter gaspillerait le budget de la fonction.
    if (interroges > 0) await pause(PAUSE_ENTRE_COMPTES_MS);
    interroges++;
    trace(
      `parent ${parent.parentId} : ${interroges}e connexion, ` +
        `${fenetres.map((f) => f.cle).join("+")}, ${Date.now() - commence} ms ecoulees`,
    );

    try {
      traites.push(
        await traiterParent(parent, {
          aujourdhui,
          semaine,
          echeance,
          restants,
          fenetres,
          trace,
          expedier,
        }),
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
    dureeMs: Date.now() - commence,
    interroges,
    nonTraites,
  };
}

type Compte = {
  parentId: string;
  email: string;
  portailEmail: string;
  mdpChiffre: string;
  echecs: number;
  alerteEchecLe: Date | null;
  joursAvant: number[];
  joursSilencieux: number[];
};

/**
 * Les valeurs de `envois.type`.
 *
 * Le perimetre en fait partie : sans lui, un rappel de garderie pose a 16 h
 * occuperait la ligne du jour, et le filet de 19 h conclurait « deja notifie »
 * si une reservation de cantine venait d'etre annulee entre-temps.
 */
type TypeEnvoi = "rappel_cantine" | "rappel_periscolaire" | "confirmation";

const RAPPELS: TypeEnvoi[] = ["rappel_cantine", "rappel_periscolaire"];

/** Les jours de periscolaire que les fenetres du jour ont reellement regardes. */
function joursRegardes(fenetres: Fenetre[]): Date[] {
  const vus = new Set<number>();
  for (const f of fenetres) {
    if (f.cle === "cantine") continue;
    for (let d = f.debut; d <= f.fin; d = ajouter(d, 1)) {
      if (f.joursAttendus.has(jourSemaine(d))) vus.add(d.getTime());
    }
  }
  return [...vus].sort((a, b) => a - b).map((t) => new Date(t));
}

async function traiterParent(
  compte: Compte,
  ctx: {
    aujourdhui: Date;
    semaine: Date;
    echeance: Date;
    restants: number;
    fenetres: Fenetre[];
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

    // Reessais sur panne du portail, jamais sur identifiants refuses. Les
    // fenetres viennent du cycle : c'est lui qui sait si la cantine est due
    // aujourd'hui et si la famille est en pause.
    const resultat = await reessayer(
      () => verifierParent(cfg, { aujourdhui: ctx.aujourdhui, fenetres: ctx.fenetres, trace: ctx.trace }),
      { trace: ctx.trace },
    );

    await succes(compte.parentId);

    const { inconnus, absentes, fenetresDepassees } = resultat.analyse;
    const signaux = {
      ...(inconnus.length ? { inconnus } : {}),
      ...(absentes.length ? { absentes } : {}),
      ...(fenetresDepassees.length ? { depassees: fenetresDepassees } : {}),
    };
    if (inconnus.length) {
      // Traites comme non reserves, donc sans risque de rappel manquant, mais
      // a classer dans ETATS_RESERVES ou ETATS_NON_RESERVES. Le CLI le signale
      // depuis toujours ; le cron est le seul a tourner tous les jours.
      ctx.trace(
        `parent ${compte.parentId} : etat(s) non repertorie(s) ${inconnus.join(", ")}, ` +
          "traite(s) comme non reserve(s)",
      );
    }
    if (absentes.length) {
      ctx.trace(
        `parent ${compte.parentId} : surveillance(s) demandee(s) mais absente(s) du ` +
          `portail : ${absentes.join(", ")} — aucune alerte ne pourra partir dessus`,
      );
    }
    if (fenetresDepassees.length) {
      // Des pointages interroges ont deja depasse leur echeance : la fenetre
      // calculee arrive trop tard, l'alerte ne servirait plus a rien. C'est le
      // seul signal qui rattrape une regle de delai erronee.
      ctx.trace(
        `parent ${compte.parentId} : FENETRE TROP TARDIVE pour ` +
          `${fenetresDepassees.join(", ")} — la regle de delai est a revoir`,
      );
    }

    const manquantsCantine = resultat.analyse.manquants.filter((m) => m.cle === "cantine");
    const manquantsPerisco = resultat.analyse.manquants.filter((m) => m.cle !== "cantine");
    const manquants = resultat.analyse.manquants.length;
    const reserves = resultat.analyse.reserves.length;
    const jourDeNouvelles = (compte.joursAvant ?? []).includes(ctx.restants);

    const decision = decider({
      manquants,
      reserves,
      jourDeNouvelles,
      joursRestants: ctx.restants,
      joursSilencieux: compte.joursSilencieux ?? [],
    });

    if (decision === "silence") {
      // Rien a reserver et rien de reserve : periode fermee cote portail. Le
      // distinguer de "tout est reserve" evite d'annoncer au parent une semaine
      // couverte pendant les vacances, et rend le cas lisible dans les logs.
      const statut = manquants === 0 && reserves === 0 ? "rien_a_verifier" : "rien_a_signaler";
      return { ...base, statut, manquants: 0, ...signaux };
    }

    const cleEnvoi = { parentId: compte.parentId, semaineVisee: iso(ctx.semaine), joursAvant: ctx.restants };

    // Une confirmation ne doit pas suivre un rappel deja parti le meme jour
    // pour la meme semaine : le parent qui vient de reserver recevrait, trois
    // heures apres son rappel, un second message lui annoncant que tout va
    // bien. La cle d'unicite ne l'en empeche pas, puisque `type` en fait
    // partie — c'est justement ce qui permet au rappel de passer apres une
    // confirmation, le sens qui, lui, rattrape une annulation de derniere
    // minute. Le garde vaut pour N'IMPORTE quel rappel du jour, quel que soit
    // son perimetre.
    if (decision === "confirmation") {
      const [rappelParti] = await db
        .select({ id: envois.id })
        .from(envois)
        .where(
          and(
            eq(envois.parentId, cleEnvoi.parentId),
            eq(envois.semaineVisee, cleEnvoi.semaineVisee),
            eq(envois.joursAvant, cleEnvoi.joursAvant),
            inArray(envois.type, RAPPELS),
          ),
        )
        .limit(1);
      if (rappelParti) return { ...base, statut: "deja_notifie", manquants };
    }

    // L'anti-doublon est porte par la contrainte d'unicite : si l'insertion ne
    // rend aucune ligne, le message est deja parti et on n'envoie rien. Une
    // ligne PAR PERIMETRE : le mail n'emportera que les sections dont le
    // creneau etait encore libre, sinon on renverrait ce qui vient de partir.
    const aPoser: TypeEnvoi[] =
      decision === "confirmation"
        ? ["confirmation"]
        : [
            ...(manquantsCantine.length ? (["rappel_cantine"] as TypeEnvoi[]) : []),
            ...(manquantsPerisco.length ? (["rappel_periscolaire"] as TypeEnvoi[]) : []),
          ];

    const poses: { id: string; type: TypeEnvoi }[] = [];
    for (const type of aPoser) {
      const [ligne] = await db
        .insert(envois)
        .values({ ...cleEnvoi, type })
        .onConflictDoNothing()
        .returning({ id: envois.id });
      if (ligne) poses.push({ id: ligne.id, type });
    }

    if (poses.length === 0) {
      return { ...base, statut: "deja_notifie", manquants };
    }

    const liens = liensPour(compte.parentId, iso(ctx.semaine));
    const message =
      decision === "rappel"
        ? mailRappel({
            aujourdhui: ctx.aujourdhui,
            cantine: poses.some((p) => p.type === "rappel_cantine")
              ? {
                  manquants: manquantsCantine,
                  semaine: ctx.semaine,
                  echeance: ctx.echeance,
                  joursRestants: ctx.restants,
                }
              : null,
            periscolaire: poses.some((p) => p.type === "rappel_periscolaire")
              ? manquantsPerisco
              : [],
            liens,
          })
        : mailConfirmation({
            cantine: ctx.fenetres.some((f) => f.cle === "cantine")
              ? {
                  semaine: ctx.semaine,
                  echeance: ctx.echeance,
                  reserves: resultat.analyse.reserves.filter((r) => r.cle === "cantine").length,
                }
              : null,
            periscolaire: { jours: joursRegardes(ctx.fenetres) },
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
      // Les lignes d'envoi ont ete posees AVANT l'expedition : ce sont elles
      // qui tiennent lieu de verrou anti-doublon. L'envoi ayant echoue, il faut
      // toutes les liberer, sinon le rejeu du filet les verrait et conclurait
      // que le message est deja parti. Une panne passagere de l'expediteur
      // deviendrait un rappel definitivement perdu — le seul echec vraiment
      // grave de ce service.
      try {
        await db.delete(envois).where(inArray(envois.id, poses.map((p) => p.id)));
      } catch (menage) {
        ctx.trace(
          `parent ${compte.parentId} : creneau(x) d'envoi non libere(s) apres echec ` +
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
      ...signaux,
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
