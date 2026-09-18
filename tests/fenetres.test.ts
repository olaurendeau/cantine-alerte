import assert from "node:assert/strict";
import { test } from "node:test";
import { fenetresPour, type ReglagesSurveillance } from "../lib/portail/index.ts";
import { iso, jourDepuisIso } from "../lib/portail/dates.ts";

/**
 * `fenetresPour` est le point de verite unique du service : tout le reste en
 * decoule mecaniquement. Une fenetre cantine non construite, et il n'y a ni
 * manquants, ni reserves, ni section de mail, ni confirmation — sans une seule
 * condition ailleurs. D'ou ce fichier dedie, qui parcourt le tableau de
 * decision ligne par ligne.
 */

// Mercredi 9 septembre 2026 : echeance lundi 14 (J-5), semaine visee lundi 21.
const MERCREDI = jourDepuisIso("2026-09-09");
const SEMAINE_VISEE = "2026-09-21";

const reglages = (p: Partial<ReglagesSurveillance> = {}): ReglagesSurveillance => ({
  joursAvant: [5],
  joursSansCantine: [],
  joursMatin: [],
  joursSoir: [],
  pauseSemaine: null,
  ...p,
});

const cles = (aujourdhui: Date, r: ReglagesSurveillance) =>
  fenetresPour({ aujourdhui, reglages: r }).map((f) => f.cle);

test("jours_avant vide coupe TOUT, periscolaire compris", () => {
  // C'est ce que pose le lien « Ne plus recevoir de rappels ». Sans ce garde, le
  // periscolaire — qui ne depend pas des jours choisis — continuerait d'ecrire
  // a une famille desabonnee, et le lien mentirait.
  assert.deepEqual(
    cles(MERCREDI, reglages({ joursAvant: [], joursMatin: [0, 1, 2, 3, 4] })),
    [],
  );
});

test("la cantine n'est regardee que les jours de nouvelles", () => {
  // J-5 aujourd'hui : la famille qui a choisi J-5 est servie, pas l'autre.
  assert.deepEqual(cles(MERCREDI, reglages({ joursAvant: [5] })), ["cantine"]);
  assert.deepEqual(cles(MERCREDI, reglages({ joursAvant: [1] })), []);
});

test("la pause retire la cantine, et elle seule", () => {
  const enPause = reglages({ pauseSemaine: SEMAINE_VISEE, joursMatin: [3] });
  // Jeudi 10 est a J+1 : la garderie du jeudi reste regardee.
  assert.deepEqual(cles(MERCREDI, enPause), ["matin"]);

  // La pause ne vaut que pour la semaine qu'elle nomme : quand l'echeance
  // passe, la semaine visee change et la cantine reprend seule, sans purge.
  const semainePrecedente = reglages({ pauseSemaine: "2026-09-14", joursMatin: [3] });
  assert.deepEqual(cles(MERCREDI, semainePrecedente), ["cantine", "matin"]);
});

test("le periscolaire n'est regarde que si un jour attendu tombe a J+1 ou J+2", () => {
  // Depuis mercredi : J+1 = jeudi (3), J+2 = vendredi (4).
  assert.deepEqual(cles(MERCREDI, reglages({ joursAvant: [], joursMatin: [3] })), []);
  assert.deepEqual(
    cles(MERCREDI, reglages({ joursAvant: [1], joursMatin: [3] })),
    ["matin"],
  );
  assert.deepEqual(
    cles(MERCREDI, reglages({ joursAvant: [1], joursSoir: [4] })),
    ["soir"],
  );
  // Lundi (0) n'est ni J+1 ni J+2 depuis mercredi : rien a verifier, donc pas
  // de connexion au portail.
  assert.deepEqual(cles(MERCREDI, reglages({ joursAvant: [1], joursMatin: [0] })), []);
});

test("les jours sans cantine sortent des jours attendus, sans toucher a la plage", () => {
  const [cantine] = fenetresPour({
    aujourdhui: MERCREDI,
    reglages: reglages({ joursSansCantine: [1, 4] }),
  });
  assert.equal(cantine.cle, "cantine");
  assert.deepEqual([...cantine.joursAttendus].sort(), [0, 2, 3, 5, 6]);
  // La plage reste la semaine visee entiere : c'est le filtre par jour de
  // semaine qui ecarte, pas un retrecissement des dates.
  assert.equal(iso(cantine.debut), SEMAINE_VISEE);
  assert.equal(iso(cantine.fin), "2026-09-27");
});

test("les exclusions de la collectivite ne sont posees que sur la cantine", () => {
  const f = fenetresPour({
    aujourdhui: MERCREDI,
    exclusions: new Set(["2026-09-24"]),
    reglages: reglages({ joursMatin: [3] }),
  });
  assert.equal(f.find((x) => x.cle === "cantine")!.exclusions.size, 1);
  // Une sortie scolaire supprime le repas, pas la garderie du matin.
  assert.equal(f.find((x) => x.cle === "matin")!.exclusions.size, 0);
});

test("seule la cantine est requise : un portail sans garderie ne casse rien", () => {
  const f = fenetresPour({
    aujourdhui: MERCREDI,
    reglages: reglages({ joursMatin: [3], joursSoir: [3] }),
  });
  assert.deepEqual(
    f.map((x) => [x.cle, x.requise]),
    [
      ["cantine", true],
      ["matin", false],
      ["soir", false],
    ],
  );
});
