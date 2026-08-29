import assert from "node:assert/strict";
import { test } from "node:test";
import { pauseConfiguree } from "../lib/service/verification.ts";

const DEFAUT = 3000;

test("une pause absente ou vide retombe sur le defaut", () => {
  // Une chaine vide est le resultat normal d'un .env recopie puis vide, ou
  // d'une variable declaree sans valeur dans le tableau de bord Vercel. Or
  // Number("") vaut 0 : sans ce garde, la pause anti-throttling disparaissait
  // en silence et le cron enchainait les connexions depuis une seule IP —
  // exactement ce qui fait renvoyer un 429 au compte valide suivant.
  assert.equal(pauseConfiguree(undefined), DEFAUT);
  assert.equal(pauseConfiguree(""), DEFAUT);
  assert.equal(pauseConfiguree("   "), DEFAUT);
});

test("une valeur illisible retombe sur le defaut", () => {
  // setTimeout(NaN) declenche immediatement : la pause disparaitrait sans un mot.
  assert.equal(pauseConfiguree("bientot"), DEFAUT);
  assert.equal(pauseConfiguree("-1"), DEFAUT);
  assert.equal(pauseConfiguree("Infinity"), DEFAUT);
});

test("une valeur numerique est respectee, zero compris", () => {
  // Zero reste legitime quand il est demande explicitement : un poste de
  // developpement avec un seul compte n'a pas de throttling a craindre.
  assert.equal(pauseConfiguree("500"), 500);
  assert.equal(pauseConfiguree(" 1500 "), 1500);
  assert.equal(pauseConfiguree("0"), 0);
});
