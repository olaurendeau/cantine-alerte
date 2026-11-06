import type { Session } from "./session.ts";
import type { ConfigPortail, Logger } from "./types.ts";
import { silencieux } from "./types.ts";

export const API = "https://gestion.logiciel-enfance.fr";
export const CONNECT = "https://connect1.3douest.com";
export const urlPortail = (cfg: Pick<ConfigPortail, "portail">) =>
  `https://parents.logiciel-enfance.fr/${cfg.portail}`;

/** Hote du SSO, cle du pot a cookies de la session. */
const HOTE_CONNECT = new URL(CONNECT).host;

/**
 * Le cookie « appareil de confiance » du SSO : pose quand le code 2FA est
 * soumis avec `remember_device=1`, il dispense du code pendant 30 jours
 * (`Max-Age=2591999`). Il n'est PAS renouvele quand on s'en sert : son
 * expiration est fixe. Observe le 2026-11-03, et le 2026-11-04 depuis une
 * autre IP.
 */
export const COOKIE_APPAREIL = "_email_2fa_device";

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
 * Le mot de passe est accepte, mais le portail exige le code 2FA envoye par
 * mail (depuis le 2026-10-08). Ni un refus — le mot de passe est bon — ni une
 * panne : sans appareil de confiance, rien ne passera sans le parent.
 *
 * ⚠️ Jamais rejouee (`nePasRejouer`) : chaque tentative envoie un code de plus
 * dans la boite du parent.
 *
 * `rejete` dit si un appareil de confiance avait ete presente. Vrai, c'est que
 * le portail ne le reconnait plus alors qu'il n'a pas expire : c'est le
 * detecteur d'une confiance liee a l'IP ou d'un changement de regle cote
 * portail, a ne pas confondre avec l'expiration normale au bout de 30 jours.
 */
export class ErreurDoubleFacteur extends Error {
  rejete: boolean;

  constructor(message: string, rejete: boolean) {
    super(message);
    this.name = "ErreurDoubleFacteur";
    this.rejete = rejete;
  }
}

/**
 * Le code 2FA soumis est refuse : le portail a re-rendu sa page de code avec un
 * message. La connexion entamee reste utilisable avec le nouveau jeton.
 */
export class ErreurCodeRefuse extends Error {
  messagePortail: string | null;
  attente: AttenteCode;

  constructor(message: string, messagePortail: string | null, attente: AttenteCode) {
    super(message);
    this.name = "ErreurCodeRefuse";
    this.messagePortail = messagePortail;
    this.attente = attente;
  }
}

/**
 * La connexion entamee n'est plus reconnue par Laravel (419) : session ou CSRF
 * expires entre la demande du code et sa saisie. Rien a rejouer, il faut un
 * nouveau code.
 */
export class ErreurConnexionExpiree extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErreurConnexionExpiree";
  }
}

/**
 * Une connexion arretee sur la page du code 2FA : de quoi soumettre le code
 * dans la meme session Laravel.
 */
export type AttenteCode = { jeton: string; referer: string };

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

/** Un JWT emis par le serveur d'authentification, n'importe ou dans la chaine suivie. */
const jetonAuth = (etapes: { url: string; res: Response; texte: string }[]): string | undefined =>
  etapes
    .flatMap((e) => [
      ...tokensDe(e.texte),
      ...tokensDe(e.res.headers.get("location") ?? ""),
      ...tokensDe(e.url),
    ])
    .find((t) => jwtPayload(t).iss === "3douest-auth-server");

const PAGE_CODE = /name=["']email_2fa_code["']/;

/** Ce que rend la soumission du mot de passe, quand ce n'est ni un refus ni une panne. */
type IssueMotDePasse =
  | { etat: "connecte"; auth: string }
  | { etat: "code_requis"; attente: AttenteCode };

/**
 * Sauts 1 a 3 : du token d'amorcage a la soumission du mot de passe.
 *
 * Rend un JWT, ou la page du code 2FA ; leve sur tout le reste. Partage par
 * `login` (le cron, qui ne peut pas saisir de code) et `demanderCode`
 * (l'association, qui le peut).
 */
async function soumettreMotDePasse(
  cfg: ConfigPortail,
  session: Session,
  trace: Logger,
): Promise<IssueMotDePasse> {
  const { go, goSuivi } = session;
  const redirectUri = urlPortail(cfg);

  // L'appareil de confiance doit etre dans le pot avant le saut 3, ou le SSO
  // le lit. Le poser des le debut est sans effet sur les sauts 1 et 2.
  if (cfg.appareil) session.poser(HOTE_CONNECT, COOKIE_APPAREIL, cfg.appareil);

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
  const auth = jetonAuth(etapes);
  if (!auth) {
    // ⚠️ Un 429 ou un 5xx est une panne, QUOI QUE raconte la page servie.
    // Ce garde est inconditionnel et doit le rester : les pages d'erreur des
    // pare-feu (Cloudflare : `cf-error-details`, `cf-alert-error`) portent des
    // classes que `messagesErreur` reconnait, et seraient donc prises pour un
    // message du portail. Les laisser devenir ErreurIdentifiants desactiverait
    // un compte parfaitement valide au bout de trois cycles — exactement ce que
    // le service s'interdit — sans aucun signal, `aIgnorer` ecartant les
    // identifiants refuses.
    // ⚠️ C'est le DERNIER maillon qui porte le statut operant, pas le premier.
    // `goSuivi` ne suit que les 3xx : une panne comme un refus TERMINE donc la
    // chaine. Quand le POST redirige et que c'est le GET suivi qui tombe — mise
    // en production cote portail, pare-feu qui bloque, ou notre propre
    // throttling par IP — `premiere.status` vaut 302 et ne dit rien. Lire le
    // premier maillon desactiverait un compte valide pour une panne qui n'a
    // rien a voir avec le parent. Une seule notion pour les deux gardes
    // ci-dessous, sans quoi l'un couvre la chaine et l'autre pas.
    const statutOperant = etapes[etapes.length - 1].res.status;

    if (statutOperant === 429 || statutOperant >= 500) {
      refuserSiIndisponible(statutOperant, "la soumission des identifiants");
    }

    // ⚠️ Observe le 2026-11-03 : le SSO exige desormais un code a 6 chiffres
    // envoye par mail apres le mot de passe. Le mot de passe a donc ete ACCEPTE,
    // et le code est deja parti dans la boite du parent.
    const pageCode = etapes.find((e) => PAGE_CODE.test(e.texte));
    if (pageCode) {
      const jeton = champCache(pageCode.texte, "_token");
      if (!jeton) {
        throw new ErreurStructure(
          "Page du code 2FA sans _token : le formulaire du portail a probablement change.",
        );
      }
      return { etat: "code_requis", attente: { jeton, referer: `${CONNECT}/connexion?${qs}` } };
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
      refuserSiIndisponible(statutOperant, "la soumission des identifiants");
    }
    // ⚠️ Une page servie sans que le portail ait rien dit n'est PAS un refus.
    // C'est ainsi que la page 2FA a desactive un compte valide le 2026-10-20 :
    // ni JWT, ni message, ni statut d'erreur, donc « identifiants refuses ». Un
    // refus se reconnait a son message ; sans lui, c'est une page qu'on ne sait
    // pas lire. Le cas « 302 au corps vide » reste un refus : c'est la forme
    // documentee, qui n'a jamais rien porte d'autre.
    const derniere = etapes[etapes.length - 1].texte;
    if (erreurs.length === 0 && statutOperant < 300 && derniere.trim() !== "") {
      const titre = derniere.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() || "sans titre";
      throw new ErreurStructure(
        `Page inattendue apres le mot de passe (HTTP ${statutOperant}, « ${titre.slice(0, 120)} ») : ` +
          "ni jeton ni message du portail. Le flux de connexion a probablement change.",
      );
    }
    throw new ErreurIdentifiants(
      `Connexion refusee (HTTP ${statutOperant}) : identifiants invalides ou throttling.`,
      erreurs[0] ?? null,
    );
  }

  return { etat: "connecte", auth };
}

/** Saut 4 : le JWT du SSO contre le Bearer applicatif. */
async function echangerBearer(
  cfg: ConfigPortail,
  session: Session,
  auth: string,
  trace: Logger,
): Promise<string> {
  trace("[4] echange contre le Bearer");
  const res = await session.go(`${API}/api/login`, {
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

/**
 * Authentification en 4 sauts entre le SSO Laravel (connect1.3douest.com) et
 * l'API metier (gestion.logiciel-enfance.fr). Retourne le Bearer applicatif.
 *
 * Sans personne pour saisir un code : la page 2FA leve `ErreurDoubleFacteur`.
 * C'est `cfg.appareil` qui permet de passer, cf. `COOKIE_APPAREIL`.
 */
export async function login(
  cfg: ConfigPortail,
  session: Session,
  trace: Logger = silencieux,
): Promise<string> {
  const issue = await soumettreMotDePasse(cfg, session, trace);
  if (issue.etat === "code_requis") {
    const rejete = Boolean(cfg.appareil);
    throw new ErreurDoubleFacteur(
      rejete
        ? "Le portail redemande le code 2FA malgre un appareil de confiance non expire : " +
            "il ne le reconnait plus."
        : "Le portail exige le code 2FA envoye par email : aucun appareil de confiance " +
            "n'est associe a ce compte.",
      rejete,
    );
  }
  return echangerBearer(cfg, session, issue.auth, trace);
}

/** Un appareil de confiance obtenu, a conserver chiffre. */
export type Appareil = { valeur: string; expireLe: Date | null };

/**
 * Premier temps de l'association : mot de passe, puis arret sur la page du
 * code. Le portail envoie le code a ce moment-la.
 *
 * Si le portail n'exige pas de code, la connexion est deja complete.
 */
export async function demanderCode(
  cfg: ConfigPortail,
  session: Session,
  trace: Logger = silencieux,
): Promise<{ etat: "connecte"; bearer: string } | { etat: "code_requis"; attente: AttenteCode }> {
  const issue = await soumettreMotDePasse({ ...cfg, appareil: undefined }, session, trace);
  if (issue.etat === "code_requis") return issue;
  return { etat: "connecte", bearer: await echangerBearer(cfg, session, issue.auth, trace) };
}

/**
 * Second temps : le code, dans la MEME session que `demanderCode`, avec
 * `remember_device=1`. Rend le Bearer et l'appareil de confiance pose par le SSO.
 *
 * Le refus d'un code se lit comme celui d'un mot de passe : page du code
 * re-rendue ET message du portail → `ErreurCodeRefuse`. Sans message, c'est une
 * page qu'on ne sait pas lire, meme regle qu'au saut 3.
 */
export async function validerCode(
  cfg: ConfigPortail,
  session: Session,
  attente: AttenteCode,
  code: string,
  trace: Logger = silencieux,
): Promise<{ bearer: string; appareil: Appareil }> {
  trace("[3b] soumission du code 2FA");
  const etapes = await session.goSuivi(`${CONNECT}/connexion`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: CONNECT,
      referer: attente.referer,
    },
    body: new URLSearchParams({
      _token: attente.jeton,
      email_2fa_code: code,
      remember_device: "1",
    }).toString(),
  });
  if (etapes[0].res.status === 419) {
    throw new ErreurConnexionExpiree(
      "419 : la connexion entamee a expire cote Laravel, redemander un code.",
    );
  }

  const auth = jetonAuth(etapes);
  if (!auth) {
    const statut = etapes[etapes.length - 1].res.status;
    if (statut === 429 || statut >= 500) refuserSiIndisponible(statut, "la soumission du code");
    const page = etapes.find((e) => PAGE_CODE.test(e.texte));
    const erreurs = etapes.flatMap((e) => messagesErreur(e.texte));
    const jeton = page ? champCache(page.texte, "_token") : null;
    if (page && jeton && erreurs.length > 0) {
      throw new ErreurCodeRefuse("Code 2FA refuse par le portail.", erreurs[0], {
        ...attente,
        jeton,
      });
    }
    refuserSiIndisponible(statut, "la soumission du code");
    throw new ErreurStructure(
      `Reponse inattendue a la soumission du code 2FA (HTTP ${statut}) : ni jeton ni message.`,
    );
  }

  const appareil = session.cookie(HOTE_CONNECT, COOKIE_APPAREIL);
  if (!appareil) {
    // Connecte cette fois-ci, mais rien qui dispense du code demain : le cron
    // retomberait sur la page 2FA des le premier passage.
    throw new ErreurStructure(
      `Code accepte, mais le portail n'a pas pose de cookie ${COOKIE_APPAREIL} : ` +
        "l'appareil de confiance n'est pas memorise.",
    );
  }
  const bearer = await echangerBearer(cfg, session, auth, trace);
  return { bearer, appareil: { valeur: appareil.valeur, expireLe: appareil.expireLe } };
}
