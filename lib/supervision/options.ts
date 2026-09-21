import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/nextjs";
import { nettoyerEvenement, urlSansSecrets, type EvenementNettoyable } from "./anonymiser.ts";
import { aIgnorer } from "./filtres.ts";

/**
 * Les options d'initialisation, partagees par les trois runtimes.
 *
 * Un seul endroit : serveur, edge et navigateur doivent filtrer exactement
 * pareil. Trois copies finiraient par diverger, et c'est toujours celle qu'on
 * a oublie de mettre a jour qui laisse passer le jeton.
 *
 * ⚠️ Ce module importe le SDK pour ses types uniquement. Les deux modules
 * qu'il appelle (`anonymiser`, `filtres`) restent purs, donc testables dans une
 * CI sans reseau ni secret.
 */

/**
 * Le DSN, en variable publique.
 *
 * `NEXT_PUBLIC_` parce que le navigateur en a besoin et qu'un DSN est public
 * par construction : il autorise a ECRIRE des evenements, jamais a lire le
 * projet. Une seule variable pour les trois runtimes, pour la meme raison que
 * ci-dessus.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";

/**
 * Pas de DSN, pas de SDK.
 *
 * C'est l'interrupteur general, et il est volontairement passif : le service
 * doit tourner a l'identique sans Sentry — en local, dans l'image Docker, chez
 * un contributeur qui a juste copie le `.env.example`. On n'allume la
 * supervision qu'en posant la variable la ou on la veut.
 */
export const supervisionActive = dsn !== "";

/**
 * Environnement et version, pour ne pas confondre une preview avec la prod.
 *
 * Vercel expose les deux, en clair cote serveur et en `NEXT_PUBLIC_` cote
 * navigateur. Sans le `release`, une pile de production resterait illisible :
 * c'est lui qui relie l'evenement aux sources televersees.
 */
const environnement =
  process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV ?? "developpement";

const version =
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA;

export function optionsCommunes() {
  return {
    dsn,
    enabled: supervisionActive,
    environment: environnement,
    ...(version ? { release: version } : {}),

    /**
     * ⚠️ Jamais vrai, et jamais `includeLocalVariables` non plus.
     *
     * `sendDefaultPii` joindrait l'IP, les en-tetes et le corps des requetes.
     * `includeLocalVariables` serait pire : le mot de passe du portail est
     * dechiffre en memoire pendant le cycle, il se retrouverait dans la pile
     * de la premiere erreur venue.
     */
    sendDefaultPii: false,

    /**
     * Assez pour reperer une lenteur, pas assez pour remplir le quota. La
     * valeur de ce projet est dans les erreurs et les check-ins de cron, pas
     * dans les traces : descendre a 0 ne ferait rien perdre d'essentiel.
     */
    tracesSampleRate: 0.1,

    /**
     * ⚠️ Pas de Session Replay, et ce n'est pas un oubli : il filmerait
     * l'ecran du parent, donc les prenoms de ses enfants, pour les rejouer
     * chez un tiers.
     */

    beforeSend(evenement: ErrorEvent, indice?: EventHint): ErrorEvent | null {
      if (aIgnorer(indice?.originalException)) return null;
      // `nettoyerEvenement` mute puis rend l'objet recu : on le laisse
      // travailler sur celui-ci et on rend l'original, ce qui evite de
      // reconstruire un type que le SDK fait evoluer a chaque version.
      nettoyerEvenement(evenement as unknown as EvenementNettoyable);
      return evenement;
    },

    /**
     * Les fils d'Ariane sont la surface la plus facile a oublier : ils
     * enregistrent chaque `fetch` et chaque navigation, donc chaque URL — et
     * nos URL portent des jetons.
     */
    beforeBreadcrumb(fil: Breadcrumb): Breadcrumb | null {
      const donnees = fil?.data;
      if (donnees) {
        // `url` pour un fetch, `from`/`to` pour une navigation : les trois
        // portent une URL, donc potentiellement un jeton.
        for (const cle of ["url", "from", "to"]) {
          if (typeof donnees[cle] === "string") donnees[cle] = urlSansSecrets(donnees[cle]);
        }
      }
      return fil;
    },
  };
}
