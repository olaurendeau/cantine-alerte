import type { Logger } from "./types.ts";
import { silencieux } from "./types.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/**
 * fetch attend indefiniment par defaut. Le cron traite les familles en sequence
 * dans une fonction plafonnee a 300 s : un seul portail qui ne repond plus
 * consommerait tout le budget et les familles suivantes ne seraient jamais
 * traitees, sans la moindre trace. Mieux vaut echouer vite sur une famille que
 * perdre la file.
 */
const DELAI_MAX_MS = 15_000;

/**
 * Budget de la session entiere, en plus du delai par requete.
 *
 * Le delai par requete ne borne pas une famille : la connexion fait quatre
 * sauts et goSuivi en suit jusqu'a cinq de plus, chacun repartant a zero. Au
 * pire une seule famille tenait donc 150 s sur les 300 s de la fonction, ce que
 * le commentaire ci-dessus promettait justement d'empecher. L'echeance part a
 * la creation de la session, donc couvre connexion et lecture des prestations.
 */
const BUDGET_SESSION_MS = 45_000;

/**
 * Rend une URL lisible dans les traces : masque les JWT (un token d'amorcage
 * fait plusieurs centaines de caracteres et n'a rien a faire dans un log) et
 * tronque le reste.
 */
export function propre(texte: unknown, max = 120): string {
  const sans = String(texte).replace(
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "<jwt>",
  );
  return sans.length > max ? `${sans.slice(0, max)}[...]` : sans;
}

export type Etape = { url: string; res: Response; texte: string };
export type Session = ReturnType<typeof nouvelleSession>;

/**
 * fetch ne persiste ni cookies ni redirections. Chaque session a son propre
 * pot a cookies : c'est ce qui permet au cron d'iterer sur plusieurs familles
 * sans qu'une session fuite sur la suivante.
 */
export function nouvelleSession(
  trace: Logger = silencieux,
  { budgetMs = BUDGET_SESSION_MS }: { budgetMs?: number } = {},
) {
  const jar = new Map<string, string>();
  // Un seul signal pour toute la session : il court des la creation, donc le
  // temps deja consomme par les sauts precedents n'est pas remis a zero.
  const echeanceSession = AbortSignal.timeout(budgetMs);

  function absorber(res: Response) {
    const noms: string[] = [];
    for (const ligne of res.headers.getSetCookie?.() ?? []) {
      const [paire] = ligne.split(";");
      const i = paire.indexOf("=");
      if (i > 0) {
        const nom = paire.slice(0, i).trim();
        jar.set(nom, paire.slice(i + 1).trim());
        noms.push(nom);
      }
    }
    if (noms.length) trace("cookies:", noms.join(", "));
  }

  async function go(url: string, opts: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "user-agent": UA,
      ...((opts.headers as Record<string, string>) ?? {}),
    };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, {
      signal: AbortSignal.any([echeanceSession, AbortSignal.timeout(DELAI_MAX_MS)]),
      ...opts,
      headers,
      redirect: "manual",
    });
    absorber(res);
    trace(`${opts.method ?? "GET"} ${propre(url)} -> ${res.status}`);
    const loc = res.headers.get("location");
    if (loc) trace("location:", propre(loc));
    return res;
  }

  /**
   * Suit une chaine de redirections en conservant chaque reponse. Sur echec de
   * connexion Laravel repond 302 avec un corps quasi vide : sans cela on ne
   * verrait rien et on conclurait a tort.
   */
  async function goSuivi(url: string, opts: RequestInit = {}, sauts = 5): Promise<Etape[]> {
    const etapes: Etape[] = [];
    let res = await go(url, opts);
    etapes.push({ url, res, texte: await res.text() });
    while (res.status >= 300 && res.status < 400 && sauts-- > 0) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const suivante = new URL(loc, url).href;
      res = await go(suivante, { headers: { referer: url } });
      etapes.push({ url: suivante, res, texte: await res.text() });
      url = suivante;
    }
    return etapes;
  }

  return { go, goSuivi, jar };
}
