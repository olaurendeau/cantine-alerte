import assert from "node:assert/strict";
import { test } from "node:test";
import { adminEmails, estAdmin } from "../lib/service/verification.ts";

test("sans ADMIN_EMAILS, personne n'est administrateur", () => {
  // Fail-closed : une variable oubliee doit fermer /admin, jamais l'ouvrir.
  assert.equal(estAdmin("moi@exemple.fr", {}), false);
  assert.deepEqual(adminEmails({}), []);
  assert.equal(estAdmin("moi@exemple.fr", { ADMIN_EMAILS: "" }), false);
  assert.equal(estAdmin("moi@exemple.fr", { ADMIN_EMAILS: " , , " }), false);
});

test("la comparaison ignore la casse et les espaces", () => {
  // L'adresse vient du cookie de session, pose au moment de la connexion : elle
  // n'a pas forcement la meme casse que la variable d'environnement.
  const env = { ADMIN_EMAILS: " Admin@Exemple.FR , autre@exemple.fr " };
  assert.equal(estAdmin("admin@exemple.fr", env), true);
  assert.equal(estAdmin("  ADMIN@EXEMPLE.FR  ", env), true);
  assert.equal(estAdmin("autre@exemple.fr", env), true);
});

test("une adresse absente de la liste reste refusee", () => {
  const env = { ADMIN_EMAILS: "admin@exemple.fr" };
  assert.equal(estAdmin("parent@exemple.fr", env), false);
  // Pas de correspondance partielle : un prefixe ne suffit pas.
  assert.equal(estAdmin("admin@exemple.fr.attaquant.fr", env), false);
  assert.equal(estAdmin("", env), false);
});
