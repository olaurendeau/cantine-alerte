import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.SESSION_SECRET = randomBytes(32).toString("base64");
const { signerPause, verifierPause } = await import("../lib/auth/pause.ts");
const { signerDesabonnement } = await import("../lib/auth/desabonnement.ts");

const PARENT = "11111111-1111-4111-8111-111111111111";
const AUTRE = "22222222-2222-4222-8222-222222222222";
const SEMAINE = "2026-09-21";

test("un jeton signe se relit, parent et semaine compris", () => {
  assert.deepEqual(verifierPause(signerPause(PARENT, SEMAINE)), {
    parentId: PARENT,
    semaine: SEMAINE,
  });
});

test("un jeton forge est refuse", () => {
  // Sans signature, n'importe qui pourrait faire taire les rappels d'un autre
  // foyer en devinant un identifiant.
  assert.equal(verifierPause(`${PARENT}.${SEMAINE}.signaturebidon`), null);
  assert.equal(verifierPause(PARENT), null);
  assert.equal(verifierPause(""), null);
});

test("la signature d'une semaine ne vaut pas pour une autre", () => {
  // La semaine fait partie de la charge signee : sans cela, un lien d'un vieux
  // mail ferait taire la semaine en cours, que le parent n'a jamais examinee.
  const [, , signature] = signerPause(PARENT, SEMAINE).split(".");
  assert.equal(verifierPause(`${PARENT}.2026-09-28.${signature}`), null);
});

test("la signature d'un parent ne vaut pas pour un autre", () => {
  const [, , signature] = signerPause(PARENT, SEMAINE).split(".");
  assert.equal(verifierPause(`${AUTRE}.${SEMAINE}.${signature}`), null);
});

test("un jeton de desabonnement ne vaut pas un jeton de pause", () => {
  // Les deux liens partent dans le meme mail. Un prefixe distinct dans le
  // message signe est ce qui empeche l'un de valoir pour l'autre — sans quoi
  // cliquer sur « pas de cantine cette semaine » pourrait desabonner.
  const [, signature] = signerDesabonnement(PARENT).split(".");
  assert.equal(verifierPause(`${PARENT}.${SEMAINE}.${signature}`), null);
});

test("un jeton tronque par un client mail est refuse", () => {
  const jeton = signerPause(PARENT, SEMAINE);
  assert.equal(verifierPause(jeton.slice(0, -4)), null);
});
