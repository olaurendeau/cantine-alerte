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
  pause: "https://cantine.exemple.fr/pause?jeton=abc",
};

const cible = (date: string, enfant: string): Cible => ({
  date: jourDepuisIso(date),
  enfant,
  prestation: "Repas enfant",
  cle: "cantine",
  code: "ETAT_NON_RESERVE",
});

const perisco = (date: string, enfant: string, cle: "matin" | "soir" = "matin"): Cible => ({
  date: jourDepuisIso(date),
  enfant,
  prestation: cle === "matin" ? "Garderie matin" : "Garderie soir",
  cle,
  code: "ETAT_NON_RESERVE",
});

const JOURS = ["2026-09-21", "2026-09-22", "2026-09-24"];
const SEMAINE = jourDepuisIso("2026-09-21");
const ECHEANCE = jourDepuisIso("2026-09-14");
// Mardi : J+1 est le mercredi 9, J+2 le jeudi 10.
const AUJOURDHUI = jourDepuisIso("2026-09-08");
const DEMAIN = "2026-09-09";
const APRES_DEMAIN = "2026-09-10";

const rappel = (manquants: Cible[], joursRestants = 6) =>
  mailRappel({
    aujourdhui: AUJOURDHUI,
    cantine: { manquants, semaine: SEMAINE, echeance: ECHEANCE, joursRestants },
    liens,
  });

const rappelPerisco = (manquants: Cible[]) =>
  mailRappel({ aujourdhui: AUJOURDHUI, cantine: null, periscolaire: manquants, liens });

const confirmation = () =>
  mailConfirmation({ cantine: { semaine: SEMAINE, echeance: ECHEANCE, reserves: 8 }, liens });

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
  const urgent = rappel([cible(JOURS[0], "Martin")], 0);
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
    ["⚠️", rappel(manquant, 6).objet],
    ["⚠️", rappel(manquant, 3).objet],
    ["🚨", rappel(manquant, 2).objet],
    ["🚨", rappel(manquant, 0).objet],
  ];
  for (const [emoji, objet] of cas) {
    assert.ok(objet.startsWith(`${emoji} `), `objet sans emoji en tete : ${objet}`);
  }
  // A J-2 l'emoji presse, mais le texte ne promet pas encore le dernier soir.
  assert.ok(!rappel(manquant, 2).texte.includes("ce soir avant minuit"));
});

test("seule, la cantine garde sa formulation d'origine", () => {
  // L'encart de tete porte deja l'echeance : la repeter dans la section serait
  // du bruit. Le rappel de l'echeance ne sert que lorsque deux sections
  // cohabitent et que l'encart ne parle que de l'une d'elles.
  const m = rappel([cible(JOURS[0], "Martin")]);
  assert.ok(m.texte.includes("Semaine du lundi 21 septembre."));
  assert.ok(!m.texte.includes("Cantine — semaine"));
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

test("une famille sans periscolaire retrouve l'objet d'origine, au caractere pres", () => {
  // Le test de non-regression du changement : la grande majorite des familles
  // n'utilisera pas la garderie, et leur message ne doit pas bouger d'un iota.
  assert.equal(
    rappel([cible(JOURS[0], "Martin")]).objet,
    "⚠️ 1 repas non réservé · semaine du lundi 21 septembre",
  );
  assert.equal(
    rappel([cible(JOURS[0], "Martin")], 0).objet,
    "🚨 Dernier jour — 1 repas non réservé pour la semaine du lundi 21 septembre",
  );
  assert.equal(confirmation().objet, "✅ Tout est réservé · semaine du lundi 21 septembre");
});

test("le gyrophare du periscolaire ne s'allume qu'au dernier jour utile", () => {
  // SEUIL_PRESSE vaut deux jours, calibre sur le cycle de sept jours de la
  // cantine. Le transposer tel quel a un cycle de deux jours le ferait sonner
  // en permanence : l'emoji ne dirait plus rien. On transpose l'intention —
  // la derniere ligne droite — qui vaut ici J-1.
  assert.ok(rappelPerisco([perisco(APRES_DEMAIN, "Martin")]).objet.startsWith("⚠️"));
  assert.ok(rappelPerisco([perisco(DEMAIN, "Martin")]).objet.startsWith("🚨"));
});

test("l'objet periscolaire nomme les jours concernes", () => {
  assert.equal(
    rappelPerisco([perisco(APRES_DEMAIN, "Martin")]).objet,
    "⚠️ 1 périscolaire non réservé · jeudi 10",
  );
  // Dernier jour utile : la formulation d'urgence est vraie ce soir-la.
  assert.equal(
    rappelPerisco([perisco(DEMAIN, "Martin")]).objet,
    "🚨 Dernier jour — 1 périscolaire non réservé",
  );
  assert.ok(rappelPerisco([perisco(DEMAIN, "Martin")]).texte.includes("ce soir avant minuit"));
});

test("en mixte, l'objet epouse le perimetre le plus pressant", () => {
  // L'apercu mobile tronque : ce qui expire en premier doit tenir dans les
  // premiers caracteres. Un objet a parts egales rendrait « Dernier jour »
  // litteralement faux pour l'un des deux perimetres.
  const m = mailRappel({
    aujourdhui: AUJOURDHUI,
    cantine: { manquants: [cible(JOURS[0], "Martin")], semaine: SEMAINE, echeance: ECHEANCE, joursRestants: 6 },
    periscolaire: [perisco(DEMAIN, "Soline")],
    liens,
  });
  assert.equal(m.objet, "🚨 Dernier jour — 1 périscolaire non réservé · et 1 repas");
  // Les deux sections sont la, dans l'ordre fixe cantine puis periscolaire.
  assert.ok(m.texte.indexOf("Cantine") < m.texte.indexOf("Périscolaire"));
  // Et chacune porte SA propre echeance : l'encart ne parle que de la plus
  // pressante, sans quoi « ce soir avant minuit » se lirait comme valant aussi
  // pour la cantine, qui a six jours devant elle.
  assert.ok(m.texte.includes("Cantine — semaine du lundi 21 septembre. À réserver avant"), m.texte);
  assert.ok(m.texte.includes("dans 6 jours"));
  assert.ok(m.texte.includes("Périscolaire — à réserver la veille avant minuit."));
  assert.ok(m.texte.includes("Martin"));
  assert.ok(m.texte.includes("Soline"));
});

test("le periscolaire dit le moment concerne, pas seulement le jour", () => {
  // Sans le moment, le parent ne sait pas laquelle des deux inscriptions poser.
  const m = rappelPerisco([
    perisco(DEMAIN, "Martin", "matin"),
    perisco(DEMAIN, "Martin", "soir"),
    perisco(APRES_DEMAIN, "Soline", "soir"),
  ]);
  assert.ok(m.texte.includes("mercredi 9 (matin et soir)"), m.texte);
  assert.ok(m.texte.includes("jeudi 10 (soir)"), m.texte);
});

test("le bouton de pause n'apparait que sur un rappel de cantine", () => {
  // Il ne coupe que la cantine : l'afficher sur un message qui ne parle que de
  // garderie promettrait un silence qu'il ne tient pas.
  assert.ok(rappel([cible(JOURS[0], "Martin")]).html.includes(liens.pause!));
  assert.ok(!rappelPerisco([perisco(DEMAIN, "Martin")]).html.includes(liens.pause!));
  assert.ok(!confirmation().html.includes(liens.pause!));
});

test("la confirmation garde une ligne par periode, jamais une phrase globale", () => {
  // La cantine se confirme sur une semaine, le periscolaire sur deux jours. Un
  // « tout est reserve » unique affirmerait une couverture de la garderie sur
  // des jours qu'on n'a jamais regardes.
  const m = mailConfirmation({
    cantine: { semaine: SEMAINE, echeance: ECHEANCE, reserves: 8 },
    periscolaire: { jours: [jourDepuisIso(DEMAIN), jourDepuisIso(APRES_DEMAIN)] },
    liens,
  });
  assert.ok(m.texte.includes("Les 8 repas de la semaine sont réservés"));
  assert.ok(m.texte.includes("Périscolaire : rien à réserver mercredi 9 et jeudi 10."));

  // Periscolaire seul : la semaine visee n'a pas ete regardee, on n'en parle pas.
  const seul = mailConfirmation({
    cantine: null,
    periscolaire: { jours: [jourDepuisIso(DEMAIN)] },
    liens,
  });
  assert.equal(seul.objet, "✅ Rien à réserver · mercredi 9");
  assert.ok(!seul.texte.includes("repas de la semaine"));
});
