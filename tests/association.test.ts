import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, test } from "node:test";

process.env.CANTINE_CLE_CHIFFREMENT = randomBytes(32).toString("base64");
const { nouvelleSession } = await import("../lib/portail/session.ts");
const { codePropre, PLAFOND_REDEMANDE_MS, redemandePossibleLe, relire, serialiser } = await import(
  "../lib/service/association.ts"
);

const PARENT_A = "11111111-1111-4111-8111-111111111111";
const PARENT_B = "22222222-2222-4222-8222-222222222222";

const fetchOrigine = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOrigine;
});

/** `new Response` filtre set-cookie : on fabrique la reponse a la main. */
function reponse(setCookie: string[]): Response {
  return {
    status: 200,
    headers: {
      get: () => null,
      getSetCookie: () => setCookie,
    },
    text: async () => "",
  } as unknown as Response;
}

test("une session exportee puis reprise renvoie les memes cookies au meme hote", async () => {
  // C'est tout l'enjeu : la seconde requete du parent, un quart d'heure plus
  // tard et dans une autre invocation serverless, doit parler a Laravel avec
  // la session qui a demande le code.
  const vus: { url: string; cookie: string | undefined }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    vus.push({ url, cookie: (init.headers as Record<string, string>).cookie });
    return reponse(
      url.includes("connect1")
        ? ["laravel-session=abc; Max-Age=7200; HttpOnly", "XSRF-TOKEN=xyz; Max-Age=7200"]
        : [],
    );
  }) as typeof fetch;

  const premiere = nouvelleSession();
  await premiere.go("https://connect1.3douest.com/connexion");
  const exporte = JSON.parse(JSON.stringify(premiere.exporter()));

  const reprise = nouvelleSession(undefined, { pot: exporte });
  await reprise.go("https://connect1.3douest.com/connexion");
  await reprise.go("https://gestion.logiciel-enfance.fr/api/login");

  assert.equal(vus[1].cookie, "laravel-session=abc; XSRF-TOKEN=xyz");
  // Le pot reste range par hote apres le voyage.
  assert.equal(vus[2].cookie, undefined);
  // L'expiration survit au passage par JSON.
  assert.ok(reprise.cookie("connect1.3douest.com", "laravel-session")?.expireLe instanceof Date);
});

test("la connexion entamee se chiffre, et ne se relit que pour son parent", () => {
  const attente = {
    pot: [["connect1.3douest.com", [["laravel-session", "abc", null]]]] as [
      string,
      [string, string, string | null][],
    ][],
    jeton: "jeton-csrf",
    referer: "https://connect1.3douest.com/connexion?token=t",
    portailEmail: "parent@exemple.fr",
    motDePasse: "s3cr3t",
  };
  const chiffree = serialiser(attente, PARENT_A);
  // Ni le mot de passe ni le cookie de session ne paraissent en clair en base.
  assert.doesNotMatch(chiffree, /s3cr3t|abc|parent@/);
  assert.deepEqual(relire(chiffree, PARENT_A), attente);
  // AAD = parent_id : recopiee sur une autre ligne, elle est rejetee.
  assert.throws(() => relire(chiffree, PARENT_B));
});

test("le code se saisit avec ou sans espaces, et compte six chiffres", () => {
  assert.equal(codePropre("539989"), "539989");
  assert.equal(codePropre(" 539 989 "), "539989");
  assert.equal(codePropre("539-989"), "539989");
  assert.equal(codePropre("53998"), null);
  assert.equal(codePropre("5399890"), null);
  assert.equal(codePropre("abcdef"), null);
  assert.equal(codePropre(""), null);
});

test("un nouveau code ne se redemande qu'apres deux minutes", () => {
  // Chaque demande est une connexion complete depuis l'IP du service, dont le
  // throttling frappe toutes les familles, et un mail de plus chez le parent.
  const demandeeLe = new Date("2026-11-06T09:00:00Z");
  assert.equal(PLAFOND_REDEMANDE_MS, 2 * 60_000);
  assert.equal(redemandePossibleLe(demandeeLe).toISOString(), "2026-11-06T09:02:00.000Z");
});
