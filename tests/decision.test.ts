import assert from "node:assert/strict";
import { test } from "node:test";
import { decider } from "../lib/service/decision.ts";

test("un repas manquant declenche toujours un rappel", () => {
  // Meme un jour marque silencieux : le silence ne concerne que les
  // confirmations, jamais une alerte.
  assert.equal(
    decider({ manquants: 8, reserves: 20, joursRestants: 4, joursSilencieux: [4] }),
    "rappel",
  );
  assert.equal(
    decider({ manquants: 1, reserves: 10, joursRestants: 0, joursSilencieux: [0, 1, 2] }),
    "rappel",
  );
});

test("par defaut on confirme meme quand tout est reserve", () => {
  // Liste vide = comportement par defaut : une boite vide ne permet pas de
  // distinguer "tout va bien" d'un service en panne.
  assert.equal(
    decider({ manquants: 0, reserves: 8, joursRestants: 4, joursSilencieux: [] }),
    "confirmation",
  );
});

test("la confirmation se coupe jour par jour", () => {
  const silencieux = [4, 5];
  assert.equal(
    decider({ manquants: 0, reserves: 8, joursRestants: 4, joursSilencieux: silencieux }),
    "silence",
  );
  assert.equal(
    decider({ manquants: 0, reserves: 8, joursRestants: 5, joursSilencieux: silencieux }),
    "silence",
  );
  // Un jour non liste continue de confirmer.
  assert.equal(
    decider({ manquants: 0, reserves: 8, joursRestants: 0, joursSilencieux: silencieux }),
    "confirmation",
  );
});

test("une fenetre sans repas reserve ni repas a reserver ne confirme rien", () => {
  // Vacances ou hors annee scolaire : le portail ne propose rien. Confirmer
  // annoncerait "tout est reserve" pour zero repas, ce qui est faux et inquiete
  // plus que ca ne rassure.
  //
  // Le critere porte sur les repas reserves, PAS sur le nombre de pointages :
  // pendant les vacances le portail en renvoie tout de meme, fermes et
  // verrouilles. Cf. le test de bout en bout dans prestations.test.ts.
  assert.equal(
    decider({ manquants: 0, reserves: 0, joursRestants: 4, joursSilencieux: [] }),
    "silence",
  );
  // Y compris a J-0, ou la confirmation serait normalement la plus attendue.
  assert.equal(
    decider({ manquants: 0, reserves: 0, joursRestants: 0, joursSilencieux: [] }),
    "silence",
  );
});

test("un seul repas reserve suffit a confirmer", () => {
  // La borne du test precedent : des qu'il y a quelque chose a annoncer, on
  // annonce. Le silence est reserve aux fenetres reellement vides.
  assert.equal(
    decider({ manquants: 0, reserves: 1, joursRestants: 4, joursSilencieux: [] }),
    "confirmation",
  );
});
