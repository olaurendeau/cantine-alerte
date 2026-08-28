#!/usr/bin/env node
/**
 * Envoie un mail de test via le fournisseur configure. Sert a valider une
 * configuration Brevo sans attendre le prochain rappel, et a voir tout de
 * suite les erreurs les plus courantes (cle invalide, expediteur non verifie).
 *
 *   node scripts/tester-mail.ts moi@exemple.fr
 *   MAIL_PROVIDER=brevo node scripts/tester-mail.ts moi@exemple.fr
 */

import { chargerEnv } from "./env.ts";

chargerEnv();

const { expediteur } = await import("../lib/mail/index.ts");

const destinataires = process.argv.slice(2).filter((a) => a.includes("@"));
if (destinataires.length === 0) {
  console.error("Usage : node scripts/tester-mail.ts <email> [autre@email]");
  process.exit(2);
}

const fournisseur = process.env.MAIL_PROVIDER ?? "console";
console.log(`Fournisseur : ${fournisseur}`);
if (fournisseur === "brevo") {
  console.log(`Expediteur  : ${process.env.MAIL_EXPEDITEUR ?? "(MAIL_EXPEDITEUR manquante)"}`);
}
console.log(`Destinataires : ${destinataires.join(", ")}\n`);

// On envoie un vrai gabarit, pas un message ad hoc : le but est de juger le
// rendu dans un client reel, ce qu'un apercu navigateur ne dit pas.
const { mailRappel } = await import("../lib/mail/messages.ts");
const { jourDepuisIso } = await import("../lib/portail/dates.ts");

const jours = ["2026-09-21", "2026-09-22", "2026-09-24", "2026-09-25"];
const exemple = mailRappel({
  manquants: ["Martin", "Soline"].flatMap((enfant) =>
    jours.map((d) => ({
      date: jourDepuisIso(d),
      enfant,
      prestation: "Repas enfant",
      code: "ETAT_NON_RESERVE",
    })),
  ),
  semaine: jourDepuisIso("2026-09-21"),
  echeance: jourDepuisIso("2026-09-14"),
  joursRestants: 6,
  urgent: false,
  liens: {
    reservation: "https://parents.logiciel-enfance.fr/argentiere",
    reglages: `${process.env.APP_URL ?? "http://localhost:3000"}/reglages`,
  },
});

try {
  await expediteur()({
    destinataires,
    objet: `[test] ${exemple.objet}`,
    corps: exemple.texte,
    html: exemple.html,
  });
  console.log("\nEnvoi accepte.");
  if (fournisseur === "brevo") {
    console.log(
      "Verifiez la reception : un envoi accepte par l'API peut encore finir en spam si le " +
        "domaine de l'expediteur n'est pas authentifie.",
    );
  }
} catch (e) {
  const message = (e as Error).message;
  console.error(`\nEchec : ${message}`);
  if (/401/.test(message)) {
    console.error("→ Cle API refusee. Verifiez BREVO_API_KEY.");
  }
  if (/400/.test(message) && /sender/i.test(message)) {
    console.error(
      "→ Expediteur refuse. L'adresse MAIL_EXPEDITEUR doit etre validee dans Brevo " +
        "(code a 6 chiffres recu par mail), ou son domaine authentifie.",
    );
  }
  process.exit(1);
}
process.exit(0);
