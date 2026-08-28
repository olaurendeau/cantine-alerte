import assert from "node:assert/strict";
import { test } from "node:test";
import { normaliserUrl, urlPublique } from "../lib/url-publique.ts";

test("un hote sans schema devient une URL absolue en https", () => {
  // Le cas qui cassait en production : Next refuse de rediriger vers une URL
  // relative, et l'echec ne survenait qu'au clic du parent sur son lien.
  assert.equal(
    normaliserUrl("cantine-alerte.adventurecoding.xyz"),
    "https://cantine-alerte.adventurecoding.xyz",
  );
});

test("un hote local reste en http", () => {
  assert.equal(normaliserUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normaliserUrl("127.0.0.1:3000"), "http://127.0.0.1:3000");
});

test("une URL deja complete est conservee, sans barre finale", () => {
  assert.equal(normaliserUrl("https://exemple.fr"), "https://exemple.fr");
  assert.equal(normaliserUrl("https://exemple.fr/"), "https://exemple.fr");
  assert.equal(normaliserUrl("  https://exemple.fr///  "), "https://exemple.fr");
});

test("une valeur inexploitable est signalee avec son contenu", () => {
  assert.throws(() => normaliserUrl("https://"), /APP_URL invalide/);
});

test("APP_URL prime sur les variables Vercel", () => {
  assert.equal(
    urlPublique({ APP_URL: "cantine.exemple.fr", VERCEL_URL: "deploiement.vercel.app" }),
    "https://cantine.exemple.fr",
  );
});

test("a defaut, le domaine de production prime sur celui du deploiement", () => {
  // VERCEL_URL designe un deploiement precis et change a chaque mise en ligne :
  // un lien de connexion doit rester valide au-dela.
  assert.equal(
    urlPublique({
      VERCEL_PROJECT_PRODUCTION_URL: "cantine.exemple.fr",
      VERCEL_URL: "cantine-abc123.vercel.app",
    }),
    "https://cantine.exemple.fr",
  );
});

test("sans rien, on retombe sur le poste de developpement", () => {
  assert.equal(urlPublique({}), "http://localhost:3000");
});
