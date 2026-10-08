import assert from "node:assert/strict";
import { test } from "node:test";
import { ErreurIdentifiants, ErreurTemporaire, login } from "../lib/portail/auth.ts";
import type { Session } from "../lib/portail/session.ts";
import type { ConfigPortail } from "../lib/portail/types.ts";

/**
 * `login()` n'avait aucun test, alors que c'est le seul endroit du service ou
 * se decide « ce parent a-t-il donne de mauvais identifiants ? ». Une erreur de
 * verdict y coute cher dans les deux sens :
 *
 * - prendre une panne pour un refus **desactive un compte valide** au bout de
 *   trois cycles, et le fait en silence — `aIgnorer` ecarte les identifiants
 *   refuses, donc aucune alerte ne part ;
 * - prendre un refus pour une panne laisse le parent lire indefiniment « vos
 *   identifiants ne sont pas en cause », sans jamais lui proposer de les
 *   corriger.
 */

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** Un JWT de la forme que `tokensDe` sait reconnaitre. */
const jwt = (iss: string) => `${b64({ alg: "HS256" })}.${b64({ iss })}.signature`;

const FORMULAIRE =
  `<form><input type="hidden" name="_token" value="csrf123">` +
  `<input type="hidden" name="api_key" value="cantine2"></form>`;

/** La page que Laravel re-rend sur un refus : son formulaire ET son message. */
const REFUS = `${FORMULAIRE}<div role="alert">Mauvais email et/ou mot de passe.</div>`;

/**
 * Une page de pare-feu. Ses classes contiennent « error » et « alert », donc
 * `messagesErreur` y voit un message — c'est tout le piege.
 */
const CLOUDFLARE =
  `<div class="cf-error-details-wrapper"><span class="cf-alert-error">` +
  `Banned. You are being rate limited.</span></div>`;

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

const reponse = (statut: number, corps: string) =>
  new Response(corps, { status: statut, headers: { "content-type": "text/html" } });

/**
 * Une session dont les deux premiers sauts reussissent toujours : ce qu'on
 * teste ici est le verdict du troisieme.
 */
function sessionJusquAuSaut3(statut: number, corps: string): Session {
  const go = async (url: string) => {
    if (url.includes("/api/redirecturi")) {
      return reponse(200, `{"token":"${jwt("3douestcantineserver")}"}`);
    }
    if (url.includes("/connexion")) return reponse(200, FORMULAIRE);
    return reponse(200, "");
  };
  const goSuivi = async (url: string) => [{ url, res: reponse(statut, corps), texte: corps }];
  return { go, goSuivi } as unknown as Session;
}

/**
 * Une chaine : le POST redirige, et c'est le maillon suivi qui repond.
 *
 * `goSuivi` suit les 302, donc la panne peut tomber ailleurs que sur la
 * premiere reponse — et un garde qui ne regarde que celle-ci la manquerait.
 */
function sessionEnChaine(statutFinal: number, corpsFinal: string): Session {
  const go = async (url: string) => {
    if (url.includes("/api/redirecturi")) {
      return reponse(200, `{"token":"${jwt("3douestcantineserver")}"}`);
    }
    return reponse(200, FORMULAIRE);
  };
  const goSuivi = async (url: string) => [
    { url, res: reponse(302, ""), texte: "" },
    { url: `${url}?suivi`, res: reponse(statutFinal, corpsFinal), texte: corpsFinal },
  ];
  return { go, goSuivi } as unknown as Session;
}

test("un 429 au saut 3 reste une panne, meme derriere une page d'erreur", async () => {
  // LE cas qui compte. Le throttling du portail est par adresse IP : « trois
  // connexions ratees d'affilee ont fait retourner un 429 au compte suivant,
  // pourtant valide ». Si cette page devenait un refus d'identifiants, le
  // service desactiverait des comptes parfaitement valides pendant une panne —
  // exactement ce qu'il s'interdit — et sans qu'aucune alerte ne parte.
  await assert.rejects(
    () => login(config(), sessionJusquAuSaut3(429, CLOUDFLARE)),
    (e: unknown) => e instanceof ErreurTemporaire && (e as ErreurTemporaire).statut === 429,
  );
});

test("un 5xx au saut 3 reste une panne, meme derriere une page d'erreur", async () => {
  await assert.rejects(
    () => login(config(), sessionJusquAuSaut3(503, CLOUDFLARE)),
    (e: unknown) => e instanceof ErreurTemporaire && (e as ErreurTemporaire).statut === 503,
  );
});

test("un 403 de pare-feu ne desactive pas un compte valide", async () => {
  // Pas de formulaire re-rendu : ce n'est pas le portail qui parle. Le classer
  // en refus suspendrait le compte au bout de trois cycles.
  await assert.rejects(
    () => login(config(), sessionJusquAuSaut3(403, CLOUDFLARE)),
    (e: unknown) => e instanceof ErreurTemporaire && (e as ErreurTemporaire).statut === 403,
  );
});

test("un vrai refus reste un refus, et porte le message du portail", async () => {
  // Formulaire re-rendu AVEC son message : le portail a traite la demande.
  await assert.rejects(
    () => login(config(), sessionJusquAuSaut3(200, REFUS)),
    (e: unknown) =>
      e instanceof ErreurIdentifiants &&
      (e as ErreurIdentifiants).messagePortail === "Mauvais email et/ou mot de passe.",
  );
});

test("un refus exprime en 403 reste un refus", async () => {
  // La regle « la discrimination succes/echec ne se fait pas sur le code HTTP »
  // tient dans ce sens aussi : le formulaire et le message priment sur le
  // statut, sans quoi le parent ne saurait jamais qu'il doit corriger.
  await assert.rejects(
    () => login(config(), sessionJusquAuSaut3(403, REFUS)),
    (e: unknown) => e instanceof ErreurIdentifiants,
  );
});

test("une panne qui tombe apres la redirection reste une panne", async () => {
  // Le POST repond 302, `goSuivi` suit, et c'est le GET suivant qui echoue —
  // mise en production cote portail, ou notre propre throttling par IP. Un
  // garde qui ne regarderait que la premiere reponse verrait un 302 et
  // classerait la panne en refus d'identifiants : compte valide desactive au
  // bout de trois cycles, et sans aucune alerte.
  for (const statut of [429, 503]) {
    await assert.rejects(
      () => login(config(), sessionEnChaine(statut, CLOUDFLARE)),
      (e: unknown) => e instanceof ErreurTemporaire && (e as ErreurTemporaire).statut === statut,
    );
  }
});

test("un pare-feu qui bloque apres la redirection ne desactive pas un compte", async () => {
  // Meme page de pare-feu que plus haut, arrivee un maillon plus loin :
  // Cloudflare en bot-fight mode, ou un proxy qui refuse le GET suivi. Lire le
  // premier maillon verrait un 302, que rien ne classe, et le refus
  // d'identifiants suspendrait un compte parfaitement valide — en silence.
  for (const statut of [401, 403]) {
    await assert.rejects(
      () => login(config(), sessionEnChaine(statut, CLOUDFLARE)),
      (e: unknown) => e instanceof ErreurTemporaire && (e as ErreurTemporaire).statut === statut,
    );
  }
});

test("un refus suivi d'une redirection reste un refus", async () => {
  // Le cas nominal reel : le portail repond 302 vers /connexion, et la page
  // suivie porte le formulaire re-rendu avec son message.
  await assert.rejects(
    () => login(config(), sessionEnChaine(200, REFUS)),
    (e: unknown) =>
      e instanceof ErreurIdentifiants &&
      (e as ErreurIdentifiants).messagePortail === "Mauvais email et/ou mot de passe.",
  );
});

test("une absence de JWT sans message ni formulaire est un refus", async () => {
  // Cas nominal documente : 302 vers /connexion, corps quasi vide.
  await assert.rejects(
    () => login(config(), sessionJusquAuSaut3(302, "")),
    (e: unknown) => e instanceof ErreurIdentifiants,
  );
});
