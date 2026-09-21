/**
 * Point d'entree de l'instrumentation serveur (convention Next).
 *
 * `register()` est appele une fois par instance, avant la premiere requete.
 * Le chargement est conditionne au runtime : importer la config Node dans
 * l'edge, ou l'inverse, casse le build.
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config.ts");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config.ts");
  }
}

/**
 * Les erreurs que Next attrape lui-meme : rendu de composant serveur, action
 * serveur, route. Sans ce branchement, elles s'arretent aux journaux Vercel.
 *
 * Le nettoyage n'est pas ici mais dans `beforeSend` : il doit s'appliquer a
 * TOUT ce qui part, y compris a ce qu'on capture explicitement ailleurs.
 */
export const onRequestError = Sentry.captureRequestError;
