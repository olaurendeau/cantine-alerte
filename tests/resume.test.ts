import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enumerer,
  etatGlobal,
  resumeDestinataires,
  resumeIdentifiants,
  resumeRappels,
  resumeSurveillance,
} from "../app/reglages/resume.ts";

const IDENTIFIANTS_OK = {
  actif: true,
  portailEmail: "parent@exemple.fr",
  motDePasseEnregistre: true,
  verifieLe: new Date("2026-09-17T06:12:00Z"),
  derniereErreur: null,
};

test("enumerer se lit comme une phrase", () => {
  assert.equal(enumerer([]), "");
  assert.equal(enumerer(["lundi"]), "lundi");
  assert.equal(enumerer(["lundi", "mardi"]), "lundi et mardi");
  assert.equal(enumerer(["lundi", "mardi", "jeudi"]), "lundi, mardi et jeudi");
});

test("des identifiants verifies se resument sans avoir a deplier", () => {
  const r = resumeIdentifiants(IDENTIFIANTS_OK);
  assert.equal(r.ton, "ok");
  assert.match(r.texte, /parent@exemple\.fr/);
  assert.match(r.texte, /17\/09\/2026/);
});

test("des identifiants absents ou refuses reclament l'attention", () => {
  // Sans identifiants rien n'est surveille : c'est le seul reglage dont
  // l'absence vide le service de son objet.
  assert.equal(
    resumeIdentifiants({ ...IDENTIFIANTS_OK, portailEmail: null, verifieLe: null }).ton,
    "attention",
  );
  assert.equal(
    resumeIdentifiants({ ...IDENTIFIANTS_OK, motDePasseEnregistre: false }).ton,
    "attention",
  );
  assert.equal(resumeIdentifiants({ ...IDENTIFIANTS_OK, actif: false }).ton, "attention");
});

test("une panne du portail ne se peint pas en rouge", () => {
  // Le compte reste actif : l'echec est technique, le parent n'a rien a
  // corriger. Le signaler oui, l'accuser non.
  const r = resumeIdentifiants({ ...IDENTIFIANTS_OK, derniereErreur: "502 sur /api/login" });
  assert.equal(r.ton, "neutre");
  assert.match(r.texte, /échoué/);
});

test("les destinataires se listent, et leur absence alerte", () => {
  assert.deepEqual(resumeDestinataires(["a@x.fr", "b@x.fr"]), {
    ton: "ok",
    texte: "a@x.fr et b@x.fr",
  });
  assert.equal(resumeDestinataires([]).ton, "attention");
});

test("la surveillance se resume sans deborder sur le week-end", () => {
  // Tant que la famille n'a rien enregistre, `joursCantine` vaut les sept
  // jours : la base stocke l'absence de cantine, donc la liste vide vaut
  // « partout ». Le resume ne doit pas pour autant annoncer samedi et dimanche,
  // que la grille ne propose meme pas.
  const r = resumeSurveillance({ cantine: [0, 1, 2, 3, 4, 5, 6], matin: [], soir: [] });
  assert.equal(r.ton, "ok");
  assert.equal(r.texte, "Cantine tous les jours · périscolaire non surveillé.");
});

test("un resume ferme nomme le periscolaire meme quand il est eteint", () => {
  // Il part eteint et sans annonce : si le resume ne parlait que de cantine,
  // une famille qui n'ouvre jamais la section ne saurait pas qu'il existe.
  assert.match(
    resumeSurveillance({ cantine: [0, 1], matin: [], soir: [] }).texte,
    /périscolaire non surveillé\.$/,
  );
  // Des qu'un creneau est coche, la mention disparait : elle dirait le contraire
  // de ce que la ligne annonce juste avant.
  assert.doesNotMatch(
    resumeSurveillance({ cantine: [0, 1], matin: [], soir: [3] }).texte,
    /non surveillé/,
  );
});

test("la surveillance detaille chaque perimetre coche", () => {
  const r = resumeSurveillance({ cantine: [0, 1, 3, 4], matin: [3], soir: [0, 3] });
  assert.equal(r.ton, "ok");
  assert.equal(
    r.texte,
    "Cantine lundi, mardi, jeudi et vendredi · Matin jeudi · Soir lundi et jeudi.",
  );
});

test("une grille entierement decochee alerte", () => {
  assert.equal(resumeSurveillance({ cantine: [], matin: [], soir: [] }).ton, "attention");
});

test("surveiller la garderie seule reste valable, mais se relit", () => {
  const r = resumeSurveillance({ cantine: [], matin: [0, 1, 2, 3, 4], soir: [] });
  assert.equal(r.ton, "neutre");
  assert.equal(r.texte, "Matin tous les jours.");
});

test("les jours de rappel se lisent dans le sens de la semaine", () => {
  // `jours_avant` compte a rebours de l'echeance : 3 = vendredi, 0 = lundi.
  // Tries tels quels ils sortiraient a l'envers du calendrier.
  const r = resumeRappels({ joursAvant: [0, 3, 1], joursSilencieux: [], avecCantine: true });
  assert.equal(r.ton, "ok");
  assert.equal(
    r.texte,
    "Prévenu vendredi, dimanche et lundi (dernier jour pour la cantine).",
  );
});

test("les confirmations coupees se disent dans le resume", () => {
  assert.match(
    resumeRappels({ joursAvant: [1, 2], joursSilencieux: [1, 2], avecCantine: true }).texte,
    /seulement en cas d'oubli\.$/,
  );
  assert.match(
    resumeRappels({ joursAvant: [1, 2], joursSilencieux: [2], avecCantine: true }).texte,
    /dont 1 seulement en cas d'oubli\.$/,
  );
});

test("aucun jour de rappel est l'interrupteur general, et se voit", () => {
  // C'est ce que pose « Ne plus recevoir de rappels » depuis un mail : sans
  // cette ligne, rien sur l'ecran ne dirait que le service s'est tu.
  const r = resumeRappels({ joursAvant: [], joursSilencieux: [], avecCantine: true });
  assert.equal(r.ton, "attention");
  assert.match(r.texte, /ne recevez plus rien/);
});

test("l'etat global suit les sections, jamais l'inverse", () => {
  assert.equal(etatGlobal([]).ton, "ok");
  const r = etatGlobal(["vos identifiants du portail", "les destinataires des rappels"]);
  assert.equal(r.ton, "attention");
  assert.equal(
    r.texte,
    "À compléter : vos identifiants du portail et les destinataires des rappels.",
  );
});
