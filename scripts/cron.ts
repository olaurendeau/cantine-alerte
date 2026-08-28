#!/usr/bin/env node
/**
 * Declenche un cycle de rappel en local, sans passer par l'endpoint HTTP.
 *
 *   node scripts/cron.ts                        maintenant
 *   node scripts/cron.ts --date 2026-09-08      simule un autre jour
 *   node scripts/cron.ts --verbose
 *
 * Utile pour verifier l'anti-doublon : deux executions de suite ne doivent
 * produire qu'un seul envoi.
 */

import { chargerEnv } from "./env.ts";

chargerEnv();

const { executerCron } = await import("../lib/service/verification.ts");

const i = process.argv.indexOf("--date");
const date = i >= 0 ? process.argv[i + 1] : null;
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("--date attend le format YYYY-MM-DD");
  process.exit(2);
}

// Midi heure de Paris : la date simulee ne doit pas basculer sur la veille ou
// le lendemain selon le fuseau du poste de developpement.
const maintenant = date ? new Date(`${date}T12:00:00+02:00`) : new Date();

const resultat = await executerCron({
  maintenant,
  trace: verbose ? (...a) => console.error("  .", ...a) : undefined,
});

console.log(
  `\n${resultat.aujourdhui} | echeance ${resultat.echeance} (J-${resultat.joursRestants}) ` +
    `| semaine visee ${resultat.semaineVisee}`,
);
if (resultat.traites.length === 0) {
  console.log("Aucun compte n'a demande de rappel a J-" + resultat.joursRestants);
}
for (const t of resultat.traites) {
  console.log(`${t.email} -> ${t.statut}${t.detail ? ` (${t.detail})` : ""}`);
}
process.exit(0);
