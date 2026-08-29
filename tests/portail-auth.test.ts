import assert from "node:assert/strict";
import { test } from "node:test";
import { ErreurTemporaire, messagesErreur, refuserSiIndisponible } from "../lib/portail/auth.ts";
import { nePasRejouer } from "../lib/reessayer.ts";

test("le bloc d'erreur est identifie par role=alert, pas par sa classe", () => {
  // Le portail est en Tailwind : ses classes ne sont pas parlantes. C'est la
  // raison d'etre de la partie role="alert" de la regex — ne pas la retirer en
  // croyant simplifier.
  const html = `
    <div class="mt-2 rounded-md bg-red-50 p-4 text-sm" role="alert">
      Mauvais email et/ou mot de passe.
    </div>`;
  assert.deepEqual(messagesErreur(html), ["Mauvais email et/ou mot de passe."]);
});

test("les classes usuelles restent reconnues", () => {
  const html = `<span class="invalid-feedback">Ce champ est requis.</span>`;
  assert.deepEqual(messagesErreur(html), ["Ce champ est requis."]);
});

test("le balisage interne est retire et les espaces normalises", () => {
  const html = `<div role="alert">  <strong>Erreur</strong>\n   : compte    bloque.  </div>`;
  assert.deepEqual(messagesErreur(html), ["Erreur : compte bloque."]);
});

test("une page sans erreur ne remonte rien", () => {
  assert.deepEqual(messagesErreur("<html><body><form></form></body></html>"), []);
  assert.deepEqual(messagesErreur(""), []);
  // Un bloc vide n'est pas un message.
  assert.deepEqual(messagesErreur(`<div role="alert">   </div>`), []);
});

test("les doublons sont fusionnes et le nombre de messages est borne", () => {
  const repete = `<div role="alert">Mauvais email et/ou mot de passe.</div>`.repeat(3);
  assert.deepEqual(messagesErreur(repete), ["Mauvais email et/ou mot de passe."]);

  const beaucoup = Array.from(
    { length: 9 },
    (_, i) => `<div role="alert">Erreur ${i}</div>`,
  ).join("");
  assert.equal(messagesErreur(beaucoup).length, 5);
});

test("une panne du portail est classee avant toute lecture de la reponse", () => {
  // Les sauts 1, 2 et 4 de la connexion ne regardaient pas le statut : une page
  // d'erreur 502 ne contient aucun JWT, ce qui se lisait comme un changement de
  // HTML — donc une ErreurStructure, que l'on ne rejoue jamais. Un hoquet
  // passager du portail coutait alors definitivement son rappel a la famille.
  assert.throws(
    () => refuserSiIndisponible(502, "le token d'amorcage"),
    (e: unknown) => {
      assert.ok(e instanceof ErreurTemporaire);
      assert.ok(!nePasRejouer(e), "un 5xx merite un nouvel essai");
      return true;
    },
  );
  assert.throws(
    () => refuserSiIndisponible(429, "la page de connexion"),
    (e: unknown) => {
      assert.ok(e instanceof ErreurTemporaire);
      assert.equal(e.statut, 429);
      assert.ok(nePasRejouer(e), "insister sur un 429 prolonge le blocage par IP");
      return true;
    },
  );
});

test("les statuts qui ne disent rien d'une panne laissent passer", () => {
  // C'est la lecture qui tranchera : un 302 est le cas nominal d'un echec de
  // connexion, un 401 se classe la ou il est rencontre.
  for (const statut of [200, 302, 401, 404, 419]) {
    assert.doesNotThrow(() => refuserSiIndisponible(statut, "un saut"));
  }
});
