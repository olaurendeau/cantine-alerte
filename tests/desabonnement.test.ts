import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.SESSION_SECRET = randomBytes(32).toString("base64");
const { signerDesabonnement, verifierDesabonnement } = await import(
  "../lib/auth/desabonnement.ts"
);

const PARENT = "11111111-1111-4111-8111-111111111111";
const AUTRE = "22222222-2222-4222-8222-222222222222";

test("un jeton signe se relit", () => {
  assert.equal(verifierDesabonnement(signerDesabonnement(PARENT)), PARENT);
});

test("un jeton forge est refuse", () => {
  // Sans signature, n'importe qui pourrait couper les rappels d'un autre foyer
  // en devinant un identifiant.
  assert.equal(verifierDesabonnement(`${PARENT}.signaturebidon`), null);
  assert.equal(verifierDesabonnement(PARENT), null);
  assert.equal(verifierDesabonnement(""), null);
});

test("la signature d'un parent ne vaut pas pour un autre", () => {
  const [, signature] = signerDesabonnement(PARENT).split(".");
  assert.equal(verifierDesabonnement(`${AUTRE}.${signature}`), null);
});

test("un jeton tronque par un client mail est refuse", () => {
  const jeton = signerDesabonnement(PARENT);
  assert.equal(verifierDesabonnement(jeton.slice(0, -4)), null);
});
