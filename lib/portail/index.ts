import { login } from "./auth.ts";
import { ajouter, joursRestants, prochaineEcheance, semaineVisee } from "./dates.ts";
import { composerNotification, type Notification } from "./notification.ts";
import { analyser, getPrestations, type Analyse } from "./prestations.ts";
import { nouvelleSession } from "./session.ts";
import type { ConfigPortail, Logger } from "./types.ts";
import { silencieux } from "./types.ts";

export * from "./auth.ts";
export * from "./dates.ts";
export * from "./notification.ts";
export * from "./prestations.ts";
export * from "./session.ts";
export * from "./types.ts";

export type Resultat = {
  echeance: Date;
  semaine: Date;
  fin: Date;
  joursRestants: number;
  analyse: Analyse;
  /** null quand il n'y a rien a signaler : le silence est un resultat valide. */
  notification: Notification | null;
};

/**
 * Un cycle complet pour un parent : connexion, lecture des prestations de la
 * semaine visee, et notification si des repas manquent.
 *
 * Partage par le CLI de diagnostic et par le cron, pour qu'ils ne puissent pas
 * diverger.
 */
export async function verifierParent(
  cfg: ConfigPortail,
  {
    aujourdhui,
    semaines = 1,
    trace = silencieux,
  }: { aujourdhui: Date; semaines?: number; trace?: Logger },
): Promise<Resultat> {
  const echeance = prochaineEcheance(aujourdhui);
  const semaine = semaineVisee(echeance);
  const fin = ajouter(semaine, semaines * 7 - 1);
  const restants = joursRestants(aujourdhui, echeance);

  const session = nouvelleSession(trace);
  const bearer = await login(cfg, session, trace);
  const payload = await getPrestations(cfg, session, bearer, semaine, fin, trace);
  const analyse = analyser(payload, cfg, semaine, fin);

  return {
    echeance,
    semaine,
    fin,
    joursRestants: restants,
    analyse,
    notification: analyse.manquants.length
      ? composerNotification(cfg, {
          manquants: analyse.manquants,
          semaine,
          echeance,
          joursRestants: restants,
          // Urgent quand l'echeance tombe aujourd'hui : derniere occasion.
          urgent: restants === 0,
        })
      : null,
  };
}

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
    portail: env.CANTINE_PORTAIL ?? "argentiere",
    prestation: new RegExp(env.CANTINE_PRESTATION ?? "RepE|Repas enfant", "i"),
    exclusions: new Set(
      (env.CANTINE_EXCLUSIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ),
  };
}
