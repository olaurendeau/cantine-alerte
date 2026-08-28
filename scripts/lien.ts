#!/usr/bin/env node
/**
 * Genere un lien de connexion sans passer par le formulaire. En developpement
 * le fournisseur de mail "console" affiche deja le lien ; ce script sert quand
 * on veut le recuperer par script (tests de bout en bout).
 *
 *   node scripts/lien.ts moi@exemple.fr
 */

import { chargerEnv } from "./env.ts";

chargerEnv();

const { envoyerLienMagique } = await import("../lib/auth/liens.ts");

const email = process.argv[2] ?? process.env.CANTINE_EMAIL;
if (!email) {
  console.error("Usage : node scripts/lien.ts <email>");
  process.exit(2);
}

await envoyerLienMagique(email);
process.exit(0);
