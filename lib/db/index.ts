import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";
import { urlApplication } from "./url.ts";

type Base = ReturnType<typeof drizzle<typeof schema>>;

/**
 * En environnement serverless chaque invocation peut reutiliser le meme
 * processus : on garde la connexion sur globalThis pour ne pas ouvrir un pool
 * par requete. `max: 1` parce qu'un cycle de cron est sequentiel et que Neon
 * facture le temps de compute, pas la concurrence.
 */
const global = globalThis as typeof globalThis & {
  __cantineSql?: ReturnType<typeof postgres>;
  __cantineDb?: Base;
};

function reelle(): Base {
  if (!global.__cantineDb) {
    // postgres.js traduit ?sslmode=require en ssl, ce que Neon exige.
    global.__cantineSql ??= postgres(urlApplication(), { max: 1 });
    global.__cantineDb = drizzle(global.__cantineSql, { schema });
  }
  return global.__cantineDb;
}

/**
 * Connexion differee au premier acces, et non au chargement du module.
 *
 * Sans cela, `next build` echoue quand DATABASE_URL n'est pas encore definie :
 * la collecte des routes evalue les modules, et une erreur au chargement fait
 * tomber la construction entiere. Sur Vercel cela rendrait le premier
 * deploiement dependant de l'ordre de configuration des variables.
 */
export const db = new Proxy({} as Base, {
  get(_cible, propriete) {
    const base = reelle();
    const valeur = Reflect.get(base, propriete) as unknown;
    return typeof valeur === "function" ? valeur.bind(base) : valeur;
  },
});

export { schema };
