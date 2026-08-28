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
  const amorce = tokensDe(corpsAmorce).pop();
  if (!amorce) {
    throw new Error(
      `Token d'amorcage introuvable (HTTP ${res.status}). Verifier CANTINE_BDD ` +
        `(actuel : ${cfg.bdd}).`,
    );
  }

  trace("[2] page de connexion");
  const qs = new URLSearchParams({ token: amorce, api_key: cfg.apiKey, lang: "fr" });
  res = await go(`${CONNECT}/connexion?${qs}`);
  const page = await res.text();
  const csrf = champCache(page, "_token");
  if (!csrf) {
    throw new Error(
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
  // Avant d'interpreter l'absence de token comme un refus, ecarter les cas ou
  // le portail n'a tout simplement pas traite la demande.
  if (premiere.status === 429) {
    throw new ErreurTemporaire(
      "429 : le portail limite le debit (throttling par adresse IP). " +
        "Espacer les connexions et reessayer plus tard.",
      429,
    );
  }
  if (premiere.status >= 500) {
    throw new ErreurTemporaire(`Portail indisponible (HTTP ${premiere.status})`, premiere.status);
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
    const erreurs = etapes.flatMap((e) => messagesErreur(e.texte));
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
  let out: { data?: { token?: string } };
  try {
    out = JSON.parse(brut);
  } catch {
    throw new Error(`Reponse /api/login non JSON (HTTP ${res.status}) : ${brut.slice(0, 200)}`);
  }
  if (!out?.data?.token) {
    throw new Error(`Reponse /api/login inattendue : ${brut.slice(0, 300)}`);
  }
  return out.data.token;
}
