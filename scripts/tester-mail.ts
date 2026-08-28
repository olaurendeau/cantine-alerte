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

try {
  await expediteur()({
    destinataires,
    objet: "Test de configuration — Alerte cantine",
    corps: [
      "Si vous lisez ce message, l'envoi de mail est correctement configure.",
      "",
      "Ce message est un test, aucune action n'est attendue.",
    ].join("\n"),
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
