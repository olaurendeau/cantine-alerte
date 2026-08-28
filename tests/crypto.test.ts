import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.CANTINE_CLE_CHIFFREMENT = randomBytes(32).toString("base64");
const { chiffrer, dechiffrer, egaliteConstante } = await import("../lib/crypto.ts");

const PARENT_A = "11111111-1111-4111-8111-111111111111";
const PARENT_B = "22222222-2222-4222-8222-222222222222";

test("un mot de passe chiffre puis dechiffre revient identique", () => {
  const mdp = "s3cr3t-du-portail-éàü";
  assert.equal(dechiffrer(chiffrer(mdp, PARENT_A), PARENT_A), mdp);
});

test("deux chiffrements du meme mot de passe different", () => {
  // IV aleatoire : sinon deux parents avec le meme mot de passe seraient
  // reperables par simple comparaison des colonnes en base.
  assert.notEqual(chiffrer("identique", PARENT_A), chiffrer("identique", PARENT_A));
});

test("le chiffre ne laisse pas fuir le mot de passe", () => {
  const charge = chiffrer("MonMotDePasse", PARENT_A);
  assert.ok(!charge.includes("MonMotDePasse"));
  assert.ok(!Buffer.from(charge, "utf8").includes(Buffer.from("MonMotDePasse")));
});

test("un chiffre deplace sur un autre parent est rejete", () => {
  // C'est le role de l'AAD : recopier la ligne d'un parent vers un autre ne
  // donne pas acces a son compte portail.
  const charge = chiffrer("s3cr3t", PARENT_A);
  assert.throws(() => dechiffrer(charge, PARENT_B));
});

test("un chiffre altere est rejete", () => {
  const [iv, tag, chiffre] = chiffrer("s3cr3t", PARENT_A).split(":");
  const altere = Buffer.from(chiffre, "base64");
  altere[0] ^= 0xff;
  assert.throws(() => dechiffrer([iv, tag, altere.toString("base64")].join(":"), PARENT_A));
});

test("un format de charge invalide leve une erreur explicite", () => {
  assert.throws(() => dechiffrer("nimportequoi", PARENT_A), /Format de chiffre invalide/);
});

test("egaliteConstante compare sans fuiter la longueur du secret", () => {
  assert.ok(egaliteConstante("abc", "abc"));
  assert.ok(!egaliteConstante("abc", "abd"));
  assert.ok(!egaliteConstante("abc", "abcd"));
});
