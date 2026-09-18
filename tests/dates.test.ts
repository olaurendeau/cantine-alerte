import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aujourdhuiParis,
  fenetreVeille,
  iso,
  jourSemaine,
  libelleJourAvant,
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

test("jourSemaine compte a partir du lundi, comme le portail", () => {
  // 0 = lundi, pour coller a `planning.jour_0` du portail et a `lundiDe`.
  // getUTCDay() compte a partir du dimanche : reprendre sa valeur telle quelle
  // decalerait tous les jours attendus d'un cran, et « pas de cantine le mardi »
  // ecarterait le lundi.
  const cas: [string, number][] = [
    ["2026-09-07", 0], // lundi
    ["2026-09-08", 1], // mardi
    ["2026-09-11", 4], // vendredi
    ["2026-09-12", 5], // samedi
    ["2026-09-13", 6], // dimanche
  ];
  for (const [jour, attendu] of cas) {
    assert.equal(jourSemaine(jourDepuisIso(jour)), attendu, `depuis ${jour}`);
  }
});

test("la fenetre du periscolaire couvre les deux jours encore rattrapables", () => {
  // La reservation d'un jour D ferme au minuit qui OUVRE D : le dernier jour
  // utile est D-1, l'avant-dernier D-2. Vu d'aujourd'hui, ce sont donc J+1 et
  // J+2 — jamais aujourd'hui, dont l'echeance est passee cette nuit.
  const f = fenetreVeille(jourDepuisIso("2026-09-09"));
  assert.equal(iso(f.debut), "2026-09-10");
  assert.equal(iso(f.fin), "2026-09-11");

  // Le lundi est couvert par les passages du samedi (J+2) et du dimanche (J+1) :
  // le cron tourne tous les jours, week-end compris.
  assert.equal(iso(fenetreVeille(jourDepuisIso("2026-09-12")).fin), "2026-09-14");
  assert.equal(iso(fenetreVeille(jourDepuisIso("2026-09-13")).debut), "2026-09-14");
});

test("le suffixe « dernier jour » ne s'affiche que si la cantine est surveillee", () => {
  // Une famille qui ne suit que la garderie lirait sinon « lundi (dernier
  // jour) » alors qu'aucune echeance ne tombe ce lundi-la pour elle.
  assert.equal(libelleJourAvant(0), "lundi (dernier jour pour la cantine)");
  assert.equal(libelleJourAvant(0, { avecCantine: false }), "lundi");
  // Les autres jours ne portent pas de suffixe, dans les deux cas.
  assert.equal(libelleJourAvant(3), "vendredi");
  assert.equal(libelleJourAvant(3, { avecCantine: false }), "vendredi");
});
