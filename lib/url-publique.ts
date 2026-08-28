/**
 * Adresse publique de l'application, utilisee pour les redirections et les
 * liens de connexion envoyes par mail.
 *
 * Normalisee volontairement : Next exige des URL absolues pour rediriger, et
 * les valeurs disponibles sont rarement dans ce format. Une adresse saisie
 * "mon-app.exemple.fr" et les variables VERCEL_URL / VERCEL_PROJECT_PRODUCTION_URL
 * sont toutes fournies SANS schema. Sans normalisation, l'erreur ne survient
 * qu'a l'execution, au moment ou un parent clique sur son lien :
 *
 *   URL is malformed "mon-app.exemple.fr/reglages"
 */

type Environnement = Record<string, string | undefined>;

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/;

export function normaliserUrl(brut: string): string {
  const propre = brut.trim();
  // Un hote local n'est pas servi en HTTPS ; ailleurs on l'impose.
  const avecSchema = /^https?:\/\//i.test(propre)
    ? propre
    : `${LOCAL.test(propre) ? "http" : "https"}://${propre}`;
  try {
    // `.origin` normalise et retire toute barre finale. Ne pas les retirer en
    // amont : "https://" deviendrait "https:", auquel on recollerait un schema
    // pour obtenir l'hote absurde "https", accepte en silence.
    return new URL(avecSchema).origin;
  } catch {
    throw new Error(
      `APP_URL invalide : "${brut}". Attendu un hote ou une URL complete, ` +
        "par exemple https://cantine.exemple.fr",
    );
  }
}

/**
 * Ordre de resolution : la valeur explicite, puis le domaine de production
 * Vercel, puis l'URL du deploiement courant, puis le poste de developpement.
 * VERCEL_URL designe un deploiement precis et changerait a chaque mise en
 * ligne : elle ne sert que de dernier recours, un lien de connexion devant
 * rester valide au-dela du deploiement qui l'a emis.
 */
export function urlPublique(env: Environnement = process.env): string {
  const brut =
    env.APP_URL?.trim() ||
    env.VERCEL_PROJECT_PRODUCTION_URL?.trim() ||
    env.VERCEL_URL?.trim() ||
    "http://localhost:3000";
  return normaliserUrl(brut);
}
