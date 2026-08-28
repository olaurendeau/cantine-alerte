import type { Logger } from "./types.ts";
import { silencieux } from "./types.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

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
export function nouvelleSession(trace: Logger = silencieux) {
  const jar = new Map<string, string>();

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
    const res = await fetch(url, { ...opts, headers, redirect: "manual" });
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
