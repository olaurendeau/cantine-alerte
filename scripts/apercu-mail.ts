#!/usr/bin/env node
/**
 * Rend chaque mail avec des donnees d'exemple, dans ses variantes, vers
 * apercu/*.html plus un index. Sert a juger le rendu sans envoyer quoi que ce
 * soit, et a relire la version texte a cote du HTML.
 *
 * Un apercu navigateur ne dit rien de ce que fera Gmail ou Outlook : il sert a
 * valider la mise en page, pas la compatibilite. Pour cela, scripts/tester-mail.ts.
 *
 *   node scripts/apercu-mail.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { jourDepuisIso } from "../lib/portail/dates.ts";
import type { Cible } from "../lib/portail/types.ts";
import type { Mail } from "../lib/mail/gabarit.ts";
import {
  mailConfirmation,
  mailEchecAdmin,
  mailEchecParent,
  mailLienConnexion,
  mailRappel,
  type Liens,
} from "../lib/mail/messages.ts";

const DOSSIER = new URL("../apercu/", import.meta.url);

const liens: Liens = {
  reservation: "https://parents.logiciel-enfance.fr/argentiere",
  reglages: "https://cantine.exemple.fr/reglages",
  desabonnement: "https://cantine.exemple.fr/api/desabonnement?jeton=exemple",
};

const jour = (iso: string) => jourDepuisIso(iso);

const cible = (date: string, enfant: string): Cible => ({
  date: jour(date),
  enfant,
  prestation: "Repas enfant",
  cle: "cantine",
  code: "ETAT_NON_RESERVE",
});

const perisco = (date: string, enfant: string, cle: "matin" | "soir"): Cible => ({
  date: jour(date),
  enfant,
  prestation: cle === "matin" ? "Garderie matin" : "Garderie soir",
  cle,
  code: "ETAT_NON_RESERVE",
});

const JOURS_ECOLE = ["2026-09-21", "2026-09-22", "2026-09-24", "2026-09-25"];
const fratrie = ["Martin", "Soline"].flatMap((e) => JOURS_ECOLE.map((d) => cible(d, e)));
// Jours differents d'un enfant a l'autre : verifie que la liste ne se replie
// pas a tort.
const depareilles = [
  ...JOURS_ECOLE.map((d) => cible(d, "Martin")),
  ...JOURS_ECOLE.slice(0, 2).map((d) => cible(d, "Soline")),
];

const semaine = jour("2026-09-21");
const echeance = jour("2026-09-14");

// Le periscolaire se compte depuis aujourd'hui : J+1 est le dernier jour utile,
// J+2 le preavis.
const aujourdhui = jour("2026-09-09");
const demain = "2026-09-10";
const apresDemain = "2026-09-11";
const cantine = (joursRestants: number) => ({
  manquants: fratrie,
  semaine,
  echeance,
  joursRestants,
});

const cas: { nom: string; titre: string; mail: Mail }[] = [
  {
    nom: "rappel",
    titre: "Rappel — 6 jours avant l'échéance",
    mail: mailRappel({ aujourdhui, cantine: cantine(6), liens }),
  },
  {
    nom: "rappel-urgent",
    titre: "Rappel — dernier jour",
    mail: mailRappel({ aujourdhui, cantine: cantine(0), liens }),
  },
  {
    nom: "rappel-jours-differents",
    titre: "Rappel — enfants aux jours différents",
    mail: mailRappel({
      aujourdhui,
      cantine: { manquants: depareilles, semaine, echeance, joursRestants: 2 },
      liens,
    }),
  },
  {
    nom: "rappel-periscolaire",
    titre: "Rappel — périscolaire seul, dernier jour",
    mail: mailRappel({
      aujourdhui,
      cantine: null,
      periscolaire: [
        perisco(demain, "Martin", "matin"),
        perisco(demain, "Martin", "soir"),
        perisco(apresDemain, "Soline", "matin"),
      ],
      liens,
    }),
  },
  {
    nom: "rappel-mixte",
    titre: "Rappel — cantine et périscolaire",
    mail: mailRappel({
      aujourdhui,
      cantine: cantine(4),
      periscolaire: [perisco(demain, "Martin", "matin"), perisco(apresDemain, "Soline", "soir")],
      liens,
    }),
  },
  {
    nom: "confirmation",
    titre: "Confirmation — tout est réservé",
    mail: mailConfirmation({ cantine: { semaine, echeance, reserves: 8 }, liens }),
  },
  {
    nom: "confirmation-mixte",
    titre: "Confirmation — cantine et périscolaire",
    mail: mailConfirmation({
      cantine: { semaine, echeance, reserves: 8 },
      periscolaire: { jours: [jour(demain), jour(apresDemain)] },
      liens,
    }),
  },
  {
    nom: "lien-connexion",
    titre: "Lien de connexion",
    mail: mailLienConnexion({
      lien: "https://cantine.exemple.fr/api/auth/verifier?token=exemple",
      dureeMinutes: 20,
    }),
  },
  {
    nom: "echec-identifiants",
    titre: "Échec — identifiants refusés",
    mail: mailEchecParent({
      invalides: true,
      detail: "Mauvais email et/ou mot de passe.",
      echecs: 2,
      seuil: 3,
      desactive: false,
      liens,
    }),
  },
  {
    nom: "echec-technique",
    titre: "Échec — portail indisponible",
    mail: mailEchecParent({
      invalides: false,
      detail: "429 : le portail limite le débit (throttling par adresse IP).",
      echecs: 1,
      seuil: 3,
      desactive: false,
      liens,
    }),
  },
  {
    nom: "echec-admin",
    titre: "Échec — copie administrateur",
    mail: mailEchecAdmin({
      compte: "parent@exemple.fr",
      invalides: true,
      detail: "Mauvais email et/ou mot de passe.",
      echecs: 3,
      desactive: true,
      objetParent: "Vos identifiants du portail ne fonctionnent plus",
    }),
  },
];

mkdirSync(DOSSIER, { recursive: true });

for (const c of cas) {
  writeFileSync(new URL(`${c.nom}.html`, DOSSIER), c.mail.html);
  writeFileSync(new URL(`${c.nom}.txt`, DOSSIER), `Objet : ${c.mail.objet}\n\n${c.mail.texte}\n`);
}

/**
 * Index avec deux largeurs cote a cote : un mail se juge autant sur un ecran
 * de telephone que sur un bureau, et le comparer d'un coup evite d'oublier
 * l'un des deux.
 */
const index = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aperçu des mails</title>
<style>
  body{margin:0;background:#22201e;color:#eee;font:15px/1.5 system-ui,sans-serif}
  h1{font-size:18px;padding:20px 24px 0;margin:0}
  p.aide{padding:4px 24px 16px;margin:0;color:#a5a09a;font-size:13px}
  section{padding:20px 24px;border-top:1px solid #3a3733}
  h2{font-size:15px;margin:0 0 4px}
  .objet{color:#a5a09a;font-size:13px;margin:0 0 12px;font-family:ui-monospace,monospace}
  .cotes{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
  .cadre{background:#fff;border-radius:8px;overflow:hidden;flex:0 0 auto}
  .cadre span{display:block;background:#3a3733;color:#cfcac3;font-size:11px;padding:4px 8px}
  iframe{border:0;display:block}
</style></head><body>
<h1>Aperçu des mails</h1>
<p class="aide">Rendu navigateur, à 375 px (mobile) et 600 px (bureau). Ne présume pas du rendu réel
dans Gmail ou Outlook — pour cela, envoyer un vrai message.</p>
${cas
  .map(
    (c) => `<section>
  <h2>${c.titre}</h2>
  <p class="objet">${c.mail.objet} &nbsp;·&nbsp; <a href="${c.nom}.txt" style="color:#6ea8ff">version texte</a></p>
  <div class="cotes">
    <div class="cadre"><span>375 px</span><iframe src="${c.nom}.html" width="375" height="560"></iframe></div>
    <div class="cadre"><span>600 px</span><iframe src="${c.nom}.html" width="620" height="560"></iframe></div>
  </div>
</section>`,
  )
  .join("\n")}
</body></html>`;

writeFileSync(new URL("index.html", DOSSIER), index);

console.log(`${cas.length} mails rendus dans apercu/`);
console.log(`Ouvrir : ${new URL("index.html", DOSSIER).pathname}`);
