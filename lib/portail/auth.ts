import type { Session } from "./session.ts";
import type { ConfigPortail, Logger } from "./types.ts";
import { silencieux } from "./types.ts";

export const API = "https://gestion.logiciel-enfance.fr";
export const CONNECT = "https://connect1.3douest.com";
export const urlPortail = (cfg: Pick<ConfigPortail, "portail">) =>
  `https://parents.logiciel-enfance.fr/${cfg.portail}`;

/**
 * Identifiants refuses par le portail, par opposition a une panne technique.
 * Le cron incremente un compteur d'echecs sur ce cas precis, pas sur une
 * indisponibilite passagere du portail.
 */
export class ErreurIdentifiants extends Error {
  // Champ declare puis assigne : Node execute le TypeScript en "strip-only",
  // qui refuse les proprietes de parametre de constructeur.
  messagePortail: string | null;

  constructor(message: string, messagePortail: string | null) {
    super(message);
    this.name = "ErreurIdentifiants";
    this.messagePortail = messagePortail;
  }
}

/**
 * Indisponibilite passagere : le portail limite le debit (429) ou est en
 * erreur (5xx). A ne surtout pas confondre avec des identifiants refuses.
 *
 * Le throttling du portail est applique par ADRESSE IP, pas par compte :
 * quelques connexions rapprochees suffisent a le declencher, et il frappe
 * ensuite tous les comptes traites depuis la meme machine. Le prendre pour un
 * refus d'identifiants ferait desactiver des comptes parfaitement valides et
 * annoncerait a tort aux parents que leur mot de passe ne marche plus.
 */
export class ErreurTemporaire extends Error {
  statut: number;

  constructor(message: string, statut: number) {
    super(message);
    this.name = "ErreurTemporaire";
    this.statut = statut;
  }
}

/**
 * Le portail a repondu, mais pas ce qu'on sait lire : champ cache absent, JSON
 * illisible, structure du payload changee, ou 404 sur un point d'entree
 * documente — un point d'entree qui disparait, c'est bien l'API qui a change.
 * ⚠️ 401 et 403 N'EN SONT PLUS : cf. `refuserSiIndisponible`. Rejouer ne peut pas aider — la
 * reponse sera identique — et chaque tentative refait les quatre sauts de
 * connexion, donc alimente le throttling par IP qu'on cherche justement a
 * eviter. Ces erreurs demandent une correction du parsing, pas de la patience.
 */
export class ErreurStructure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErreurStructure";
  }
}

/**
 * Statuts qui ne disent rien de la structure de la reponse : le portail limite
 * le debit, il refuse la session, ou il est en panne.
 *
 * A appeler avant toute tentative de lecture — sauf au saut 3, seul endroit ou
 * un refus d'identifiants se juge, et ou l'ordre est donc inverse (cf. `login`).
 * Sans ce tri, un token absent ou un corps illisible dus a une page d'erreur
 * seraient pris pour un changement de HTML — donc classes en ErreurStructure,
 * que l'on ne rejoue jamais — et un hoquet passager du portail couterait
 * definitivement son rappel a la famille.
 *
 * ⚠️ **401 et 403 sont temporaires, pas structurels.** Ils etaient classes en
 * ErreurStructure au titre du « statut inattendu sur un point d'entree
 * documente ». Observe le 2026-10-08 : une panne qui ne se reproduisait plus
 * huit heures apres avait leve une alerte « le portail a change » et reclamait
 * de reprendre le parsing. Un refus d'authentification sur une session que l'on
 * vient de creer dit bien plus souvent « reessaie » que « l'API a change » —
 * ce dernier cas se presente en 404, qui reste structurel.
 *
 * Temporaire ne veut pas dire rejoue : cf. `nePasRejouer`, qui ne redonne sa
 * chance qu'aux 5xx. Trois connexions d'affilee sont precisement ce qui
 * declenche le throttling par IP.
 */
export function refuserSiIndisponible(statut: number, etape: string): void {
  if (statut === 429) {
    throw new ErreurTemporaire(
      "429 : le portail limite le debit (throttling par adresse IP). " +
        `Espacer les requetes et reessayer plus tard (${etape}).`,
      429,
    );
  }
  if (statut === 401 || statut === 403) {
    throw new ErreurTemporaire(
      `Portail : session refusee sur ${etape} (HTTP ${statut}). ` +
        "Transitoire le plus souvent ; si cela dure, le flux d'authentification a change.",
      statut,
    );
  }
  if (statut >= 500) {
    throw new ErreurTemporaire(`Portail indisponible sur ${etape} (HTTP ${statut})`, statut);
  }
}

function jwtPayload(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

const tokensDe = (texte: string): string[] =>
  texte.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];

function champCache(html: string, nom: string): string | null {
  const a = html.match(new RegExp(`<input[^>]+name=["']${nom}["'][^>]+value=["']([^"']*)["']`));
  if (a) return a[1];
  const b = html.match(new RegExp(`<input[^>]+value=["']([^"']*)["'][^>]+name=["']${nom}["']`));
  return b ? b[1] : null;
}

/**
 * Remonte le message d'erreur affiche par le portail lui-meme, par exemple
 * "Mauvais email et/ou mot de passe.". Le balisage est du Tailwind sans classe
 * parlante : c'est role="alert" qui identifie le bloc, pas la classe.
 */
export function messagesErreur(html: string): string[] {
  const re =
    /<(div|span|p|li)[^>]*(?:role=["']alert["']|class=["'][^"']*(?:alert|error|invalid-feedback|help-block)[^"']*["'])[^>]*>([\s\S]{0,500}?)<\/\1>/gi;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t) out.add(t);
  }
  return [...out].slice(0, 5);
}

/**
 * Authentification en 4 sauts entre le SSO Laravel (connect1.3douest.com) et
 * l'API metier (gestion.logiciel-enfance.fr). Retourne le Bearer applicatif.
 */
export async function login(
  cfg: ConfigPortail,
  session: Session,
  trace: Logger = silencieux,
): Promise<string> {
  const { go, goSuivi } = session;
  const redirectUri = urlPortail(cfg);

  trace("[1] token d'amorcage");
  let res = await go(`${API}/api/redirecturi`, {
    method: "POST",
    headers: { bdd: cfg.bdd, "content-type": "application/json" },
    body: JSON.stringify({ redirect_uri: redirectUri, lang: "fr" }),
  });
  const corpsAmorce = await res.text();
  refuserSiIndisponible(res.status, "le token d'amorcage");
  const amorce = tokensDe(corpsAmorce).pop();
  if (!amorce) {
    throw new ErreurStructure(
      `Token d'amorcage introuvable (HTTP ${res.status}). Verifier CANTINE_BDD ` +
        `(actuel : ${cfg.bdd}).`,
    );
  }

  trace("[2] page de connexion");
  const qs = new URLSearchParams({ token: amorce, api_key: cfg.apiKey, lang: "fr" });
  res = await go(`${CONNECT}/connexion?${qs}`);
  const page = await res.text();
  refuserSiIndisponible(res.status, "la page de connexion");
  const csrf = champCache(page, "_token");
  if (!csrf) {
    throw new ErreurStructure(
      `CSRF _token introuvable sur la page de connexion (HTTP ${res.status}). ` +
        "Le formulaire du portail a probablement change.",
    );
  }
  const champs = {
    api_key: champCache(page, "api_key") ?? cfg.apiKey,
    type: champCache(page, "type") ?? cfg.typeId,
    db: champCache(page, "db") ?? cfg.dbId,
  };

  trace("[3] soumission des identifiants");
  const etapes = await goSuivi(`${CONNECT}/connexion`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: CONNECT,
      referer: `${CONNECT}/connexion?${qs}`,
    },
    body: new URLSearchParams({
      _token: csrf,
      ...champs,
      redirect_uri: redirectUri,
      email: cfg.email,
      password: cfg.password,
    }).toString(),
  });

  const premiere = etapes[0].res;
  if (premiere.status === 419) {
    throw new Error("419 : session ou CSRF invalide cote Laravel (cookies non transmis ?)");
  }
  // Le code HTTP ne distingue pas succes et echec : sur echec le portail
  // renvoie un 302 vers /connexion, donc un corps quasi vide. Le verdict se
  // prend sur la presence d'un JWT emis par le serveur d'authentification.
  const candidats = etapes.flatMap((e) => [
    ...tokensDe(e.texte),
    ...tokensDe(e.res.headers.get("location") ?? ""),
    ...tokensDe(e.url),
  ]);
  const auth = candidats.find((t) => jwtPayload(t).iss === "3douest-auth-server");
  if (!auth) {
    // ⚠️ Un 429 ou un 5xx est une panne, QUOI QUE raconte la page servie.
    // Ce garde est inconditionnel et doit le rester : les pages d'erreur des
    // pare-feu (Cloudflare : `cf-error-details`, `cf-alert-error`) portent des
    // classes que `messagesErreur` reconnait, et seraient donc prises pour un
    // message du portail. Les laisser devenir ErreurIdentifiants desactiverait
    // un compte parfaitement valide au bout de trois cycles — exactement ce que
    // le service s'interdit — sans aucun signal, `aIgnorer` ecartant les
    // identifiants refuses.
    // ⚠️ On balaie TOUTE la chaine, pas seulement la premiere reponse.
    // `goSuivi` suit les 302 : quand le POST redirige et que c'est le GET
    // suivant qui tombe — mise en production cote portail, ou notre propre
    // throttling par IP — la panne est dans le dernier maillon et
    // `premiere.status` vaut 302. Aucun garde ne la verrait, et le compte
    // serait desactive pour une panne qui n'a rien a voir avec le parent.
    // Un tel maillon est forcement le dernier, `goSuivi` ne suivant que les 3xx.
    const panne = etapes.find((e) => e.res.status === 429 || e.res.status >= 500);
    if (panne) {
      refuserSiIndisponible(panne.res.status, "la soumission des identifiants");
    }

    const erreurs = etapes.flatMap((e) => messagesErreur(e.texte));
    // Le portail a-t-il vraiment traite la demande ? La preuve n'est pas qu'une
    // page comporte un bloc d'erreur — n'importe quel intermediaire en sert —
    // mais que LARAVEL ait re-rendu son formulaire de connexion, CSRF compris.
    // C'est ce que fait le portail sur un refus : 302 vers /connexion, suivi
    // par goSuivi, qui ramene le formulaire portant le message.
    const formulaireRendu = etapes.some((e) => champCache(e.texte, "_token") !== null);

    // Ce n'est qu'a cette condition que le statut ne decide de rien, ce qui
    // preserve la regle « la discrimination succes/echec ne se fait pas sur le
    // code HTTP » : un 403 accompagne du formulaire et de son message est un
    // refus, pas une panne. Sans cette preuve, un 401/403 vient d'un pare-feu
    // et reste temporaire — aucun compte valide n'est suspendu.
    if (!(erreurs.length > 0 && formulaireRendu)) {
      refuserSiIndisponible(premiere.status, "la soumission des identifiants");
    }
    throw new ErreurIdentifiants(
      `Connexion refusee (HTTP ${premiere.status}) : identifiants invalides, ` +
        "throttling, ou verification d'appareil de confiance active.",
      erreurs[0] ?? null,
    );
  }

  trace("[4] echange contre le Bearer");
  res = await go(`${API}/api/login`, {
    method: "POST",
    headers: { bdd: cfg.bdd, "content-type": "application/json" },
    body: JSON.stringify({ token: auth }),
  });
  const brut = await res.text();
  refuserSiIndisponible(res.status, "l'echange contre le Bearer");
  let out: { data?: { token?: string } };
  try {
    out = JSON.parse(brut);
  } catch {
    throw new ErreurStructure(
      `Reponse /api/login non JSON (HTTP ${res.status}) : ${brut.slice(0, 200)}`,
    );
  }
  if (!out?.data?.token) {
    throw new ErreurStructure(`Reponse /api/login inattendue : ${brut.slice(0, 300)}`);
  }
  return out.data.token;
}
