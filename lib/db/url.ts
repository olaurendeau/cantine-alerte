/**
 * Resolution de l'URL de connexion.
 *
 * L'integration Neon pose elle-meme ses variables dans le projet Vercel :
 * DATABASE_URL (via le pooler) et DATABASE_URL_UNPOOLED (connexion directe),
 * plus des POSTGRES_* conservees pour compatibilite. On les lit directement,
 * pour n'avoir rien a recopier a la main.
 */

/**
 * Vercel n'interprete pas les references "$AUTRE_VARIABLE" dans les valeurs :
 * la chaine arrive telle quelle. Le symptome est un "Invalid URL" au demarrage,
 * qui n'oriente pas vers la cause. On le dit explicitement.
 */
const REFERENCE_NON_RESOLUE = /^\$\{?[A-Za-z_]\w*\}?$/;

/** Plus large que NodeJS.ProcessEnv, qui impose NODE_ENV et alourdit les tests. */
type Environnement = Record<string, string | undefined>;

function premiere(noms: string[], env: Environnement): { nom: string; valeur: string } | null {
  for (const nom of noms) {
    const valeur = env[nom]?.trim();
    if (!valeur) continue;
    if (REFERENCE_NON_RESOLUE.test(valeur)) {
      throw new Error(
        `${nom} vaut litteralement "${valeur}". Vercel ne resout pas les references ` +
          "entre variables d'environnement : collez la valeur complete, ou supprimez " +
          "cette variable pour laisser l'integration Neon fournir la sienne.",
      );
    }
    return { nom, valeur };
  }
  return null;
}

function exiger(noms: string[], usage: string, env: Environnement): string {
  const trouve = premiere(noms, env);
  if (!trouve) {
    throw new Error(
      `Aucune URL de base de donnees pour ${usage}. Variables essayees : ${noms.join(", ")}.\n` +
        "En local : docker compose up -d, puis copier .env.example en .env.\n" +
        "Sur Vercel : l'integration Neon definit DATABASE_URL et DATABASE_URL_UNPOOLED.",
    );
  }
  return trouve.valeur;
}

/** Connexion de l'application : le pooler convient et menage les connexions. */
export const urlApplication = (env: Environnement = process.env): string =>
  exiger(["DATABASE_URL", "POSTGRES_URL"], "l'application", env);

/**
 * Connexion des migrations : imperativement directe. Le pooler PgBouncer
 * tourne en mode transaction et ne conserve pas l'etat de session, dont les
 * migrations et le verrou de concurrence dependent.
 */
export const urlMigration = (env: Environnement = process.env): string =>
  exiger(
    ["DATABASE_URL_MIGRATION", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DATABASE_URL"],
    "les migrations",
    env,
  );

/** Vrai si l'URL passe par le pooler Neon, qui ne convient pas aux migrations. */
export const passeParLePooler = (url: string): boolean => /-pooler\./.test(url);
