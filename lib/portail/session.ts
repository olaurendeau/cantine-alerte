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

/** Un cookie tel que le pot le garde : sa valeur, et sa date de fin si le serveur en donne une. */
export type Cookie = { valeur: string; expireLe: Date | null };

/**
 * L'expiration annoncee par un Set-Cookie. `Max-Age` prime sur `Expires`,
 * comme dans un navigateur ; ni l'un ni l'autre, c'est un cookie de session.
 */
export function expirationDe(attributs: string[], maintenant = new Date()): Date | null {
  let expires: Date | null = null;
  for (const brut of attributs) {
    const i = brut.indexOf("=");
    const nom = (i < 0 ? brut : brut.slice(0, i)).trim().toLowerCase();
    const valeur = i < 0 ? "" : brut.slice(i + 1).trim();
    if (nom === "max-age" && /^-?\d+$/.test(valeur)) {
      return new Date(maintenant.getTime() + Number(valeur) * 1000);
    }
    if (nom === "expires") {
      const d = new Date(valeur);
      if (!Number.isNaN(d.getTime())) expires = d;
    }
  }
  return expires;
}

/**
 * fetch ne persiste ni cookies ni redirections. Chaque session a son propre
 * pot a cookies : c'est ce qui permet au cron d'iterer sur plusieurs familles
 * sans qu'une session fuite sur la suivante.
 *
 * ⚠️ Le pot est rangé PAR HOTE, et un cookie ne repart que vers l'hote qui l'a
 * pose. Il envoyait auparavant tout a tout le monde, ce qui etait sans
 * consequence tant qu'il ne contenait que des cookies de session — mais le
 * cookie d'appareil de confiance de `connect1` dispense du code 2FA pendant
 * 30 jours : il n'a rien a faire chez `gestion.logiciel-enfance.fr`. Aucun des
 * cookies poses ne porte d'attribut `Domain`, donc l'hote exact suffit.
 */
export function nouvelleSession(
  trace: Logger = silencieux,
  { budgetMs = BUDGET_SESSION_MS }: { budgetMs?: number } = {},
) {
  const pot = new Map<string, Map<string, Cookie>>();
  // Un seul signal pour toute la session : il court des la creation, donc le
  // temps deja consomme par les sauts precedents n'est pas remis a zero.
  const echeanceSession = AbortSignal.timeout(budgetMs);

  const potDe = (hote: string) => {
    let cookies = pot.get(hote);
    if (!cookies) pot.set(hote, (cookies = new Map()));
    return cookies;
  };

  function absorber(url: string, res: Response) {
    const hote = new URL(url).host;
    const noms: string[] = [];
    for (const ligne of res.headers.getSetCookie?.() ?? []) {
      const [paire, ...attributs] = ligne.split(";");
      const i = paire.indexOf("=");
      if (i > 0) {
        const nom = paire.slice(0, i).trim();
        potDe(hote).set(nom, { valeur: paire.slice(i + 1).trim(), expireLe: expirationDe(attributs) });
        noms.push(nom);
      }
    }
    if (noms.length) trace(`cookies ${hote}:`, noms.join(", "));
  }

  /** Lit un cookie du pot. Ne jamais tracer la valeur : c'est un secret. */
  const cookie = (hote: string, nom: string): Cookie | undefined => pot.get(hote)?.get(nom);

  /** Pose un cookie, typiquement l'appareil de confiance conserve en base. */
  const poser = (hote: string, nom: string, valeur: string) =>
    potDe(hote).set(nom, { valeur, expireLe: null });

  async function go(url: string, opts: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "user-agent": UA,
      ...((opts.headers as Record<string, string>) ?? {}),
    };
    const cookies = pot.get(new URL(url).host);
    if (cookies?.size) {
      headers.cookie = [...cookies].map(([k, c]) => `${k}=${c.valeur}`).join("; ");
    }
    const res = await fetch(url, {
      signal: AbortSignal.any([echeanceSession, AbortSignal.timeout(DELAI_MAX_MS)]),
      ...opts,
      headers,
      redirect: "manual",
    });
    absorber(url, res);
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

  return { go, goSuivi, cookie, poser };
}
