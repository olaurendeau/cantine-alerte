/**
 * Nettoyage de ce qui part vers Sentry.
 *
 * Pur et sans import du SDK : c'est ce qui permet de le tester dans la CI, qui
 * n'a ni reseau ni secret. Les points d'entree Sentry (`sentry.*.config.ts`)
 * ne font qu'appeler ces fonctions.
 *
 * Deux dangers, de gravite tres differente :
 *
 * - les **jetons en query string**. `/connexion/verifier?token=`, `/pause` et
 *   `/desabonnement` en portent, et ils sont VIFS : un jeton de connexion
 *   recopie dans un rapport d'erreur ouvre la session du parent. Sentry capture
 *   les URL par defaut, donc on les coupe avant le `?`, partout ;
 * - les **adresses mail**, que le portail et Brevo citent volontiers dans leurs
 *   messages d'erreur. Moins grave, mais c'est une donnee personnelle chez un
 *   tiers, et la page de confidentialite s'engage dessus.
 */

/**
 * Une URL sans sa query string ni son fragment.
 *
 * On ne filtre pas parametre par parametre : une liste de noms sensibles
 * oublierait celui qu'on ajoutera l'an prochain. Le chemin seul suffit a savoir
 * ou l'erreur s'est produite, et c'est tout ce qu'on cherche.
 */
export function urlSansSecrets(url: string): string {
  if (!url) return url;
  const coupe = url.search(/[?#]/);
  return coupe === -1 ? url : url.slice(0, coupe);
}

/**
 * Les adresses mail remplacees par un marqueur.
 *
 * Le marqueur est visible a dessein : « [adresse]  refusee par le portail » se
 * lit encore, la ou une chaine vide ferait croire a un message tronque.
 */
export function sansAdresses(texte: string): string {
  // Les labels du domaine sont enumeres un a un plutot que ramasses par une
  // classe contenant le point : « ...pour parent@exemple.fr. » se terminant par
  // un point de phrase, une classe gourmande l'avalait avec le domaine et le
  // message ressortait sans ponctuation.
  return texte.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[adresse]");
}

/** Vrai si la cle designe un en-tete dont la valeur est un secret. */
const EN_TETE_SENSIBLE = /^(authorization|cookie|set-cookie|x-vercel-[\w-]*signature)$/i;

/**
 * Les en-tetes debarrasses de ceux qui portent un secret.
 *
 * `authorization` porte le `CRON_SECRET`, `cookie` la session signee. Le SDK ne
 * les envoie pas quand `sendDefaultPii` est faux, mais ce reglage se change
 * d'une ligne : on ne laisse pas la confidentialite d'un secret d'exploitation
 * dependre d'un booleen.
 */
export function sansEnTetesSensibles<T extends Record<string, unknown>>(entetes: T): Partial<T> {
  const propre: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(entetes)) {
    if (!EN_TETE_SENSIBLE.test(cle)) propre[cle] = valeur;
  }
  return propre as Partial<T>;
}

/**
 * La forme minimale d'un evenement Sentry que l'on sait nettoyer.
 *
 * On ne depend pas des types du SDK : ce module doit rester importable par un
 * test pur. Les champs absents sont simplement laisses tels quels.
 */
export type EvenementNettoyable = {
  request?: {
    url?: string;
    query_string?: unknown;
    data?: unknown;
    headers?: Record<string, unknown>;
    cookies?: unknown;
  };
  message?: string;
  breadcrumbs?: { message?: string; data?: { url?: string } & Record<string, unknown> }[];
  exception?: { values?: { value?: string }[] };
  user?: { id?: string; email?: string; ip_address?: string; username?: string };
  /**
   * Les contextes nommes (`setContext`). Chaque valeur est libre, et c'est la
   * ou atterrissent les motifs d'erreur bruts des signaux du cycle.
   */
  contexts?: Record<string, Record<string, unknown> | undefined>;
};

/**
 * Les adresses masquees partout dans une valeur de contexte, quelle qu'en soit
 * la forme.
 *
 * ⚠️ La profondeur est bornee, et ce n'est pas de la prudence decorative : on
 * tourne ici dans `beforeSend`, sur des contextes dont le SDK remplit une
 * partie (`trace`, `runtime`, `os`). Une structure circulaire ferait boucler
 * l'envoi — et une boucle n'est pas une exception, donc rien ne la rattraperait.
 * Au-dela de la limite on rend la valeur telle quelle plutot que de la perdre :
 * aucun de nos contextes n'approche cette profondeur.
 */
function valeurNettoyee(valeur: unknown, profondeur = 0): unknown {
  if (typeof valeur === "string") return sansAdresses(valeur);
  if (profondeur >= 6) return valeur;
  if (Array.isArray(valeur)) return valeur.map((v) => valeurNettoyee(v, profondeur + 1));
  if (valeur && typeof valeur === "object") {
    return Object.fromEntries(
      Object.entries(valeur as Record<string, unknown>).map(([c, v]) => [
        c,
        valeurNettoyee(v, profondeur + 1),
      ]),
    );
  }
  return valeur;
}

/**
 * L'evenement tel qu'il peut partir.
 *
 * Mute puis rend l'objet recu, comme le veut `beforeSend` : le SDK attend
 * l'evenement lui-meme, ou `null` pour l'abandonner.
 */
export function nettoyerEvenement<T extends EvenementNettoyable>(evenement: T): T {
  const { request, breadcrumbs, exception, user } = evenement;

  if (request) {
    if (request.url) request.url = urlSansSecrets(request.url);
    // Le corps d'un POST est un formulaire de reglages : identifiant portail,
    // mot de passe, adresses des destinataires. Rien a y prendre.
    delete request.query_string;
    delete request.data;
    delete request.cookies;
    if (request.headers) request.headers = sansEnTetesSensibles(request.headers);
  }

  if (evenement.message) evenement.message = sansAdresses(evenement.message);

  for (const fil of breadcrumbs ?? []) {
    if (fil.message) fil.message = sansAdresses(fil.message);
    // Les fils d'Ariane `fetch` portent l'URL appelee : celle du portail, mais
    // aussi les notres lors d'une navigation.
    if (typeof fil.data?.url === "string") fil.data.url = urlSansSecrets(fil.data.url);
  }

  for (const valeur of exception?.values ?? []) {
    if (valeur.value) valeur.value = sansAdresses(valeur.value);
  }

  // ⚠️ Les contextes etaient le seul champ libre que rien ne filtrait, alors
  // que c'est precisement la que les signaux du cycle deposent un motif
  // d'erreur brut (`exemple`) — lequel vient du portail ou de Brevo, qui citent
  // volontiers l'adresse. Les appelants assainissent deja a la source ; ce
  // passage est la ceinture, pour que le prochain contexte ajoute soit couvert
  // sans qu'on y pense.
  if (evenement.contexts) {
    evenement.contexts = valeurNettoyee(evenement.contexts) as typeof evenement.contexts;
  }

  // `setUser` ne pose qu'un id, mais le SDK complete avec l'IP quand il la
  // connait. On ne garde que l'identifiant pseudonyme.
  if (user) evenement.user = user.id ? { id: user.id } : undefined;

  return evenement;
}
