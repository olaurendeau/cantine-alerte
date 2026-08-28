import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aujourdhuiParis,
  iso,
  joursRestants,
  jourDepuisIso,
  lundiDe,
  prochaineEcheance,
  semaineVisee,
} from "../lib/portail/dates.ts";

/**
 * Le fuseau est le piege principal du service : Vercel tourne en UTC alors que
 * l'echeance est "lundi minuit" heure de Paris. Ces tests doivent passer quel
 * que soit le TZ du processus, d'ou leur execution sous plusieurs TZ dans le
 * script de test.
 */

test("aujourdhuiParis suit le calendrier parisien, pas celui du serveur", () => {
  // 22h30 UTC un dimanche d'ete = 00h30 lundi a Paris. Un calcul naif en UTC
  // dirait dimanche et enverrait un rappel "J-1" au lieu du "dernier jour".
  assert.equal(iso(aujourdhuiParis(new Date("2026-08-30T22:30:00Z"))), "2026-08-31");
  // 21h30 UTC = 23h30 a Paris, on est encore dimanche.
  assert.equal(iso(aujourdhuiParis(new Date("2026-08-30T21:30:00Z"))), "2026-08-30");
});

test("aujourdhuiParis reste juste autour des changements d'heure", () => {
  // Passage a l'heure d'ete le 29/03/2026 : UTC+1 avant, UTC+2 apres.
  assert.equal(iso(aujourdhuiParis(new Date("2026-03-28T23:30:00Z"))), "2026-03-29");
  // Retour a l'heure d'hiver le 25/10/2026 : UTC+2 avant, UTC+1 apres.
  assert.equal(iso(aujourdhuiParis(new Date("2026-10-24T22:30:00Z"))), "2026-10-25");
  assert.equal(iso(aujourdhuiParis(new Date("2026-10-25T23:30:00Z"))), "2026-10-26");
});

test("l'echeance est le prochain lundi, aujourd'hui inclus si on est lundi", () => {
  const cas: [string, string][] = [
    ["2026-08-27", "2026-08-31"], // jeudi
    ["2026-08-30", "2026-08-31"], // dimanche
    ["2026-08-31", "2026-08-31"], // lundi : la journee reste ouverte jusqu'a minuit
    ["2026-09-01", "2026-09-07"], // mardi : l'echeance suivante
  ];
  for (const [jour, attendu] of cas) {
    assert.equal(iso(prochaineEcheance(jourDepuisIso(jour))), attendu, `depuis ${jour}`);
  }
});

test("la semaine visee est celle qui commence 7 jours apres l'echeance", () => {
  assert.equal(iso(semaineVisee(jourDepuisIso("2026-08-31"))), "2026-09-07");
  assert.equal(iso(semaineVisee(jourDepuisIso("2026-09-14"))), "2026-09-21");
});

test("joursRestants vaut 0 le jour de l'echeance", () => {
  const lundi = jourDepuisIso("2026-08-31");
  assert.equal(joursRestants(lundi, lundi), 0);
  assert.equal(joursRestants(jourDepuisIso("2026-08-27"), lundi), 4);
  assert.equal(joursRestants(jourDepuisIso("2026-08-30"), lundi), 1);
});

test("joursRestants ignore le changement d'heure", () => {
  // Une semaine a cheval sur le passage a l'heure d'hiver ne fait pas 6,96 jours.
  assert.equal(joursRestants(jourDepuisIso("2026-10-20"), jourDepuisIso("2026-10-26")), 6);
});

test("lundiDe ramene au lundi de la semaine", () => {
  for (const jour of ["2026-09-21", "2026-09-23", "2026-09-27"]) {
    assert.equal(iso(lundiDe(jourDepuisIso(jour))), "2026-09-21", `depuis ${jour}`);
  }
});
