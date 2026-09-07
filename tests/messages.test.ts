import assert from "node:assert/strict";
import { test } from "node:test";
import { echapper, joursParEnfant } from "../lib/mail/gabarit.ts";
import {
  mailConfirmation,
  mailEchecParent,
  mailRappel,
  type Liens,
} from "../lib/mail/messages.ts";
import { jourDepuisIso } from "../lib/portail/dates.ts";
import type { Cible } from "../lib/portail/types.ts";

const liens: Liens = {
  reservation: "https://portail.exemple.fr/argentiere",
  reglages: "https://cantine.exemple.fr/reglages",
  desabonnement: "https://cantine.exemple.fr/desabonnement?jeton=abc",
};

const cible = (date: string, enfant: string): Cible => ({
  date: jourDepuisIso(date),
  enfant,
  prestation: "Repas enfant",
  code: "ETAT_NON_RESERVE",
});

const JOURS = ["2026-09-21", "2026-09-22", "2026-09-24"];
const SEMAINE = jourDepuisIso("2026-09-21");
const ECHEANCE = jourDepuisIso("2026-09-14");

const rappel = (manquants: Cible[], urgent = false, joursRestants = urgent ? 0 : 6) =>
  mailRappel({ manquants, semaine: SEMAINE, echeance: ECHEANCE, joursRestants, urgent, liens });

const confirmation = () =>
  mailConfirmation({ semaine: SEMAINE, echeance: ECHEANCE, reserves: 8, liens });

test("la version texte porte les memes faits que le HTML", () => {
  const m = rappel(["Martin", "Soline"].flatMap((e) => JOURS.map((d) => cible(d, e))));
  // Le repli texte doit suffire a agir : echeance, enfants, jours et surtout
  // l'URL, sur laquelle on ne peut pas cliquer depuis un libelle.
  for (const attendu of ["lundi 14 septembre", "Martin", "Soline", "lundi 21", liens.reservation]) {
    assert.ok(m.texte.includes(attendu), `texte sans "${attendu}"`);
  }
  assert.ok(m.html.includes(liens.reservation));
});

test("l'urgence change l'objet et le ton du message", () => {
  const normal = rappel([cible(JOURS[0], "Martin")]);
  const urgent = rappel([cible(JOURS[0], "Martin")], true);
  assert.ok(!normal.objet.includes("Dernier jour"));
  assert.ok(urgent.objet.includes("Dernier jour"));
  assert.ok(urgent.texte.includes("ce soir avant minuit"));
});

test("un emoji ouvre l'objet et resume l'etat en un coup d'oeil", () => {
  const manquant = [cible(JOURS[0], "Martin")];
  // L'emoji est le premier caractere de l'objet : dans une liste de messages,
  // c'est la seule position que l'apercu ne tronque jamais. Le seuil du
  // gyrophare (2 jours) est volontairement plus large que `urgent` (J-0), qui
  // commande lui des formulations vraies ce jour-la seulement.
  const cas: [string, string][] = [
    ["✅", confirmation().objet],
    ["⚠️", rappel(manquant, false, 6).objet],
    ["⚠️", rappel(manquant, false, 3).objet],
    ["🚨", rappel(manquant, false, 2).objet],
    ["🚨", rappel(manquant, true).objet],
  ];
  for (const [emoji, objet] of cas) {
    assert.ok(objet.startsWith(`${emoji} `), `objet sans emoji en tete : ${objet}`);
  }
  // A J-2 l'emoji presse, mais le texte ne promet pas encore le dernier soir.
  assert.ok(!rappel(manquant, false, 2).texte.includes("ce soir avant minuit"));
});

test("le pied de page porte le lien de desabonnement", () => {
  const m = rappel([cible(JOURS[0], "Martin")]);
  const url = liens.desabonnement!;
  assert.ok(m.texte.includes(url));
  assert.ok(m.html.includes(url));
});

test("des enfants aux memes jours donnent une liste unique", () => {
  const bloc = joursParEnfant([
    { enfant: "Martin", jours: ["lundi 21", "mardi 22"] },
    { enfant: "Soline", jours: ["lundi 21", "mardi 22"] },
  ]);
  // Repeter deux fois la meme liste allonge le mail sans rien apprendre.
  assert.ok(bloc.texte.includes("Martin, Soline"));
  assert.equal(bloc.texte.split("lundi 21").length - 1, 1);
});

test("des enfants aux jours differents gardent deux listes", () => {
  const bloc = joursParEnfant([
    { enfant: "Martin", jours: ["lundi 21", "mardi 22"] },
    { enfant: "Soline", jours: ["lundi 21"] },
  ]);
  assert.ok(!bloc.texte.includes("Martin, Soline"));
  assert.ok(bloc.texte.includes("Martin"));
  assert.ok(bloc.texte.includes("Soline"));
});

test("les donnees venues du portail sont echappees dans le HTML", () => {
  // Les prenoms viennent du portail : en HTML, une valeur non echappee est une
  // injection. La version texte, elle, doit rester intacte.
  const m = rappel([cible(JOURS[0], '<script>alert("x")</script>')]);
  assert.ok(!m.html.includes("<script>"));
  assert.ok(m.html.includes("&lt;script&gt;"));
  assert.ok(m.texte.includes('<script>alert("x")</script>'));
});

test("les motifs d'erreur de tiers sont echappes eux aussi", () => {
  const m = mailEchecParent({
    invalides: true,
    detail: 'Erreur <img src=x onerror="alert(1)">',
    echecs: 1,
    seuil: 3,
    desactive: false,
    liens,
  });
  assert.ok(!m.html.includes("<img"));
  assert.ok(m.html.includes("&lt;img"));
});

test("echapper couvre les cinq caracteres qui comptent", () => {
  assert.equal(echapper(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("un mail est un document HTML complet", () => {
  const m = rappel([cible(JOURS[0], "Martin")]);
  assert.ok(m.html.startsWith("<!doctype html>"));
  // Mise en page en tableaux : ni flexbox ni grid ne survivent a Outlook.
  assert.ok(m.html.includes('role="presentation"'));
  // Le preheader porte l'echeance dans l'apercu de notification.
  assert.ok(m.html.includes("lundi 14 septembre"));
});
