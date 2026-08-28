import assert from "node:assert/strict";
import { test } from "node:test";
import { ErreurIdentifiants, ErreurTemporaire } from "../lib/portail/auth.ts";
import { reessayer } from "../lib/reessayer.ts";

/** Attentes collectees au lieu d'etre subies, pour que les tests soient instantanes. */
function faussePatience() {
  const attentes: number[] = [];
  return {
    attentes,
    patienter: async (ms: number) => {
      attentes.push(ms);
    },
  };
}

test("rend le resultat sans reessai quand la premiere tentative reussit", async () => {
  const { attentes, patienter } = faussePatience();
  let appels = 0;
  const r = await reessayer(
    async () => {
      appels++;
      return "ok";
    },
    { patienter },
  );
  assert.equal(r, "ok");
  assert.equal(appels, 1);
  assert.deepEqual(attentes, []);
});

test("reessaie une erreur technique avec un back-off exponentiel", async () => {
  const { attentes, patienter } = faussePatience();
  let appels = 0;
  const r = await reessayer(
    async () => {
      if (++appels < 3) throw new Error("portail indisponible");
      return "ok";
    },
    { patienter, attenteInitialeMs: 2000, facteur: 3 },
  );
  assert.equal(r, "ok");
  assert.equal(appels, 3);
  assert.deepEqual(attentes, [2000, 6000]);
});

test("ne rejoue jamais des identifiants refuses", async () => {
  const { attentes, patienter } = faussePatience();
  let appels = 0;
  await assert.rejects(
    reessayer(
      async () => {
        appels++;
        throw new ErreurIdentifiants("refuse", "Mauvais email et/ou mot de passe.");
      },
      { patienter },
    ),
    /refuse/,
  );
  // Une seule tentative : rejouer un mauvais mot de passe ne peut pas reussir
  // et risque de faire verrouiller le compte cote portail.
  assert.equal(appels, 1);
  assert.deepEqual(attentes, []);
});

test("n'insiste pas sur un throttling du portail", async () => {
  const { attentes, patienter } = faussePatience();
  let appels = 0;
  await assert.rejects(
    reessayer(
      async () => {
        appels++;
        throw new ErreurTemporaire("429 : le portail limite le debit", 429);
      },
      { patienter },
    ),
    /429/,
  );
  // Rejouer sous throttling ne fait que prolonger le blocage, qui s'applique
  // par adresse IP et penaliserait donc aussi les autres comptes du cycle.
  assert.equal(appels, 1);
  assert.deepEqual(attentes, []);
});

test("reessaie une indisponibilite serveur du portail", async () => {
  const { attentes, patienter } = faussePatience();
  let appels = 0;
  const r = await reessayer(
    async () => {
      if (++appels < 2) throw new ErreurTemporaire("Portail indisponible (HTTP 503)", 503);
      return "ok";
    },
    { patienter },
  );
  assert.equal(r, "ok");
  assert.equal(appels, 2);
  assert.equal(attentes.length, 1);
});

test("propage la derniere erreur quand toutes les tentatives echouent", async () => {
  const { attentes, patienter } = faussePatience();
  let appels = 0;
  await assert.rejects(
    reessayer(
      async () => {
        appels++;
        throw new Error(`echec ${appels}`);
      },
      { patienter, tentatives: 3 },
    ),
    /echec 3/,
  );
  assert.equal(appels, 3);
  assert.equal(attentes.length, 2);
});
