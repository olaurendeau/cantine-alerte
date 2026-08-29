import { ErreurIdentifiants, ErreurStructure, ErreurTemporaire } from "./portail/auth.ts";
import type { Logger } from "./portail/types.ts";
import { silencieux } from "./portail/types.ts";

/**
 * Reessaie une operation avec un back-off exponentiel.
 *
 * Deux regles importantes :
 *
 * 1. Des identifiants refuses ne sont JAMAIS rejoues. Reessayer un mauvais mot
 *    de passe ne peut pas reussir, et enchainer les tentatives risque de faire
 *    verrouiller le compte du parent par le portail.
 * 2. Le budget total est borne. Le cron traite les familles en sequence dans une
 *    fonction Vercel plafonnee a 300 s : trois tentatives espacees de 2 s puis
 *    6 s coutent au pire ~8 s par famille, ce qui reste tenable.
 */
export type OptionsReessai = {
  tentatives?: number;
  attenteInitialeMs?: number;
  facteur?: number;
  trace?: Logger;
  /** Injectable pour les tests, evite d'attendre reellement. */
  patienter?: (ms: number) => Promise<void>;
};

/**
 * Erreurs qu'il ne faut pas rejouer dans la foulee :
 *
 * - identifiants refuses : reessayer ne peut pas reussir et enchainer les
 *   tentatives risque de faire verrouiller le compte du parent ;
 * - 429 : le portail limite deja le debit, insister prolonge le blocage. On
 *   abandonne pour cette execution et on repassera au prochain rappel ;
 * - structure illisible : le portail a repondu, mais son HTML ou son JSON a
 *   change. La reponse sera identique au coup suivant, et chaque tentative
 *   refait les quatre sauts de connexion — donc pousse vers le 429 qu'on
 *   s'applique par ailleurs a eviter.
 *
 * Les 5xx et les erreurs reseau, elles, meritent un nouvel essai.
 */
export const nePasRejouer = (e: unknown): boolean =>
  e instanceof ErreurIdentifiants ||
  e instanceof ErreurStructure ||
  (e instanceof ErreurTemporaire && e.statut === 429);

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function reessayer<T>(
  operation: () => Promise<T>,
  {
    tentatives = 3,
    attenteInitialeMs = 2000,
    facteur = 3,
    trace = silencieux,
    patienter = dormir,
  }: OptionsReessai = {},
): Promise<T> {
  let attente = attenteInitialeMs;
  let derniere: unknown;

  for (let essai = 1; essai <= tentatives; essai++) {
    try {
      return await operation();
    } catch (e) {
      derniere = e;
      if (nePasRejouer(e)) throw e;
      if (essai === tentatives) break;
      trace(
        `tentative ${essai}/${tentatives} echouee (${(e as Error).message}), ` +
          `nouvelle tentative dans ${attente} ms`,
      );
      await patienter(attente);
      attente *= facteur;
    }
  }
  throw derniere;
}
