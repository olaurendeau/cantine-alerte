import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  COOKIE_APPAREIL,
  ErreurCodeRefuse,
  ErreurDoubleFacteur,
  ErreurStructure,
  ErreurTemporaire,
  demanderCode,
  validerCode,
} from "../lib/portail/auth.ts";
import { expirationDe, nouvelleSession, type Session } from "../lib/portail/session.ts";
import type { ConfigPortail } from "../lib/portail/types.ts";
import { nePasRejouer } from "../lib/reessayer.ts";
import { appareilUtilisable } from "../lib/service/verification.ts";
import { aIgnorer, natureDe } from "../lib/supervision/filtres.ts";
import { signauxDe } from "../lib/supervision/signaux.ts";

/**
 * L'appareil de confiance : le cookie `_email_2fa_device` qui dispense du code
 * 2FA pendant 30 jours. Ce qui se joue ici, dans les deux sens :
 *
 * - le cron ne doit JAMAIS se presenter sans lui, ni rejouer une page 2FA —
 *   chaque connexion sans appareil envoie un code dans la boite du parent ;
 * - un appareil refuse alors qu'il etait valide doit crier, c'est le signe que
 *   le portail a change de regle.
 */

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (iss: string) => `${b64({ alg: "HS256" })}.${b64({ iss })}.signature`;

const config = (): ConfigPortail => ({
  email: "parent@exemple.fr",
  password: "secret",
  bdd: "cantine2_argentiere",
  apiKey: "cantine2",
  dbId: "8089",
  typeId: "9",
  portail: "argentiere",
  motifs: { cantine: /RepE/i, matin: /Gmat/i, soir: /Gsoir/i },
  exclusions: new Set<string>(),
});

const PAGE_CODE = (jeton: string, message = "") =>
  `<title>Vérification 2FA par email</title>${message}` +
  `<form method="POST"><input type="hidden" name="_token" value="${jeton}">` +
  `<input type="hidden" name="email_2fa_code"><input type="checkbox" name="remember_device" value="1"></form>`;

/**
 * Une reponse minimale. Pas `new Response` : son constructeur filtre
 * `set-cookie`, en-tete interdit cote client, alors que c'est lui qu'on teste.
 */
const reponse = (statut: number, corps: string, cookies: string[] = []) => {
  const headers = new Headers({ "content-type": "text/html" });
  for (const c of cookies) headers.append("set-cookie", c);
  return { status: statut, headers, text: async () => corps } as unknown as Response;
};

type Appel = { url: string; cookie: string | null; corps: string };
const fetchOrigine = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOrigine;
});

/** Remplace fetch par un aiguillage sur l'URL, et garde trace de chaque appel. */
function simulerPortail(aiguillage: (url: string, methode: string) => Response): Appel[] {
  const appels: Appel[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    appels.push({ url: String(url), cookie: headers.cookie ?? null, corps: String(init?.body ?? "") });
    return aiguillage(String(url), init?.method ?? "GET");
  }) as typeof fetch;
  return appels;
}

const ATTENTE = { jeton: "jeton2fa", referer: "https://connect1.3douest.com/connexion?x" };

// — Session —

test("Max-Age prime sur Expires, et rien ne vaut un cookie de session", () => {
  const t0 = new Date("2026-11-03T18:08:53Z");
  assert.equal(
    expirationDe([" expires=Thu, 03 Dec 2026 18:08:52 GMT", " Max-Age=2591999", " path=/"], t0)?.toISOString(),
    "2026-12-03T18:08:52.000Z",
  );
  assert.equal(
    expirationDe([" expires=Thu, 03 Dec 2026 18:08:52 GMT"], t0)?.toISOString(),
    "2026-12-03T18:08:52.000Z",
  );
  assert.equal(expirationDe([" path=/", " HttpOnly"], t0), null);
});

test("un cookie ne repart que vers l'hote qui l'a pose", async () => {
  // L'appareil de confiance de connect1 dispense du code 2FA : il n'a rien a
  // faire chez gestion.logiciel-enfance.fr.
  const appels = simulerPortail((url) =>
    url.includes("connect1")
      ? reponse(200, "", [`${COOKIE_APPAREIL}=secret; Max-Age=60; path=/`])
      : reponse(200, "", ["PHPSESSID=abc; path=/"]),
  );
  const s = nouvelleSession();
  await s.go("https://connect1.3douest.com/connexion");
  await s.go("https://gestion.logiciel-enfance.fr/api/login");
  await s.go("https://connect1.3douest.com/connexion");
  await s.go("https://gestion.logiciel-enfance.fr/api/login");
  assert.equal(appels[1].cookie, null);
  assert.equal(appels[2].cookie, `${COOKIE_APPAREIL}=secret`);
  assert.equal(appels[3].cookie, "PHPSESSID=abc");
  assert.ok(s.cookie("connect1.3douest.com", COOKIE_APPAREIL)?.expireLe);
});

test("un appareil pose a la main part vers le SSO", async () => {
  const appels = simulerPortail(() => reponse(200, ""));
  const s = nouvelleSession();
  s.poser("connect1.3douest.com", COOKIE_APPAREIL, "conserve");
  await s.go("https://connect1.3douest.com/connexion");
  assert.equal(appels[0].cookie, `${COOKIE_APPAREIL}=conserve`);
});

// — Association —

/** Une session dont les sauts 1 et 2 reussissent, le saut 3 rendant `page`. */
function sessionAvantCode(page: string): Session & { poses: string[] } {
  const poses: string[] = [];
  return {
    poses,
    go: async (url: string) =>
      url.includes("/api/redirecturi")
        ? reponse(200, `{"token":"${jwt("3douestcantineserver")}"}`)
        : reponse(200, `<input type="hidden" name="_token" value="csrf1">`),
    goSuivi: async (url: string) => [{ url, res: reponse(200, page), texte: page }],
    poser: (hote: string, nom: string) => poses.push(`${hote} ${nom}`),
    cookie: () => undefined,
  } as unknown as Session & { poses: string[] };
}

test("demanderCode s'arrete sur la page du code avec son jeton", async () => {
  const session = sessionAvantCode(PAGE_CODE("jeton2fa"));
  const r = await demanderCode({ ...config(), appareil: "ancien" }, session);
  assert.equal(r.etat, "code_requis");
  assert.equal(r.etat === "code_requis" && r.attente.jeton, "jeton2fa");
  // On demande un code : presenter l'ancien appareil n'aurait aucun sens.
  assert.deepEqual(session.poses, []);
});

test("le code accepte rend le Bearer et l'appareil avec son expiration", async () => {
  const appels = simulerPortail((url) => {
    if (url.endsWith("/connexion")) {
      return reponse(200, `<a href="/fin?token=${jwt("3douest-auth-server")}">`, [
        `${COOKIE_APPAREIL}=confiance; expires=Thu, 03 Dec 2026 18:08:52 GMT; Max-Age=2591999; path=/; secure; httponly`,
      ]);
    }
    return reponse(200, `{"data":{"token":"bearer"}}`);
  });
  const avant = Date.now();
  const r = await validerCode(config(), nouvelleSession(), ATTENTE, "123456");
  assert.equal(r.bearer, "bearer");
  assert.equal(r.appareil.valeur, "confiance");
  const jours = ((r.appareil.expireLe?.getTime() ?? 0) - avant) / 86_400_000;
  assert.ok(jours > 29.9 && jours < 30.1, `expiration a ${jours} jours`);
  // Sans `remember_device=1` le portail ne pose pas le cookie : c'est l'oubli
  // qui a fait rater le premier essai.
  const corps = new URLSearchParams(appels[0].corps);
  assert.equal(corps.get("remember_device"), "1");
  assert.equal(corps.get("email_2fa_code"), "123456");
  assert.equal(corps.get("_token"), "jeton2fa");
  // Le cookie du SSO ne part pas vers l'API metier.
  assert.equal(appels[1].cookie, null);
});

test("un code refuse garde la connexion, avec le nouveau jeton", async () => {
  simulerPortail(() =>
    reponse(200, PAGE_CODE("jeton3", `<div role="alert">Code invalide.</div>`)),
  );
  await assert.rejects(
    () => validerCode(config(), nouvelleSession(), ATTENTE, "000000"),
    (e: unknown) =>
      e instanceof ErreurCodeRefuse &&
      e.messagePortail === "Code invalide." &&
      e.attente.jeton === "jeton3" &&
      e.attente.referer === ATTENTE.referer,
  );
});

test("un code accepte sans cookie d'appareil n'est pas une association", async () => {
  // Connecte aujourd'hui, mais le cron retomberait sur la page 2FA demain.
  simulerPortail((url) =>
    url.endsWith("/connexion")
      ? reponse(200, `token=${jwt("3douest-auth-server")}`)
      : reponse(200, `{"data":{"token":"bearer"}}`),
  );
  await assert.rejects(
    () => validerCode(config(), nouvelleSession(), ATTENTE, "123456"),
    (e: unknown) => e instanceof ErreurStructure && /_email_2fa_device/.test((e as Error).message),
  );
});

test("une page inconnue apres le code n'est pas un code refuse", async () => {
  simulerPortail(() => reponse(200, "<title>Maintenance</title>"));
  await assert.rejects(
    () => validerCode(config(), nouvelleSession(), ATTENTE, "123456"),
    (e: unknown) => e instanceof ErreurStructure,
  );
});

test("un 429 a la soumission du code reste une panne", async () => {
  simulerPortail(() => reponse(429, PAGE_CODE("jeton3", `<div role="alert">Trop de tentatives</div>`)));
  await assert.rejects(
    () => validerCode(config(), nouvelleSession(), ATTENTE, "123456"),
    (e: unknown) => e instanceof ErreurTemporaire && e.statut === 429,
  );
});

// — Cycle et supervision —

test("une page 2FA n'est jamais rejouee", () => {
  // Rejouer refait la connexion, donc envoie un code de plus au parent.
  assert.equal(nePasRejouer(new ErreurDoubleFacteur("2FA", false)), true);
  assert.equal(nePasRejouer(new ErreurDoubleFacteur("2FA", true)), true);
});

test("sans appareil valide, le cron ne se presente pas au portail", () => {
  const maintenant = new Date("2026-11-20T12:00:00Z");
  assert.equal(appareilUtilisable({ chiffre: null, expireLe: null }, maintenant), false);
  assert.equal(
    appareilUtilisable({ chiffre: "c", expireLe: new Date("2026-11-20T11:59:59Z") }, maintenant),
    false,
  );
  assert.equal(
    appareilUtilisable({ chiffre: "c", expireLe: new Date("2026-12-03T18:08:52Z") }, maintenant),
    true,
  );
  // Expiration inconnue : on tente, le portail tranchera et un rejet efface.
  assert.equal(appareilUtilisable({ chiffre: "c", expireLe: null }, maintenant), true);
});

test("un appareil expire est normal, un appareil rejete ne l'est pas", () => {
  assert.equal(natureDe(new ErreurDoubleFacteur("2FA", true)), "appareil");
  assert.equal(aIgnorer(new ErreurDoubleFacteur("2FA", false)), true);
  assert.equal(aIgnorer(new ErreurDoubleFacteur("2FA", true)), false);
});

test("un appareil rejete leve une alerte des la premiere fois", () => {
  const [signal, ...reste] = signauxDe({
    aujourdhui: "2026-11-05",
    echeance: "2026-11-09",
    semaineVisee: "2026-11-16",
    joursRestants: 4,
    traites: [
      { parentId: "p1", email: "parent@exemple.fr", statut: "echec_technique", nature: "appareil", echecsConsecutifs: 1 },
      // Sans appareil, pas d'appel : c'est un etat, pas une panne.
      { parentId: "p2", email: "autre@exemple.fr", statut: "appareil_a_associer" },
    ],
    nonTraites: 0,
    interroges: 1,
    dureeMs: 1000,
  });
  assert.equal(reste.length, 0);
  assert.equal(signal?.empreinte, "appareil-rejete");
  assert.equal(signal?.niveau, "error");
  assert.deepEqual(signal?.contexte.parentIds, ["p1"]);
});
