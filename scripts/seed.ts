#!/usr/bin/env node
/**
 * Cree ou met a jour un compte de test en local, a partir des identifiants du
 * .env. Sert a eprouver le cron sans passer par l'interface.
 *
 *   node scripts/seed.ts --email moi@exemple.fr --rappels 0,1,3 \
 *     --destinataires moi@exemple.fr,conjoint@exemple.fr
 */

import { eq } from "drizzle-orm";
import { chargerEnv } from "./env.ts";

chargerEnv();

const { chiffrer } = await import("../lib/crypto.ts");
const { db } = await import("../lib/db/index.ts");
const { destinataires, identifiantsPortail, parents, rappels } = await import(
  "../lib/db/schema.ts"
);

function arg(nom: string, defaut?: string): string {
  const i = process.argv.indexOf(`--${nom}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && defaut === undefined) {
    throw new Error(`Argument --${nom} requis`);
  }
  return v ?? defaut!;
}

const email = arg("email", process.env.CANTINE_EMAIL ?? "");
const portailEmail = arg("portail-email", process.env.CANTINE_EMAIL ?? "");
const motDePasse = arg("mot-de-passe", process.env.CANTINE_PASSWORD ?? "");
const lireJours = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    // Sans ce filtre, "" donne [""] puis Number("") === 0 : une liste vide
    // deviendrait [0], soit le lundi passe silencieux a l'insu de tous.
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

const joursAvant = lireJours(arg("rappels", "1"));
// Jours ou l'on n'ecrit pas quand tout est deja reserve. Vide par defaut :
// la confirmation est le comportement normal.
const joursSilencieux = lireJours(arg("silencieux", ""));
const adresses = arg("destinataires", email)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!email || !portailEmail || !motDePasse) {
  console.error(
    "Identifiants manquants : renseigner CANTINE_EMAIL et CANTINE_PASSWORD dans .env, " +
      "ou passer --email / --portail-email / --mot-de-passe.",
  );
  process.exit(2);
}

const [parent] = await db
  .insert(parents)
  .values({ email, actif: true })
  .onConflictDoUpdate({ target: parents.email, set: { actif: true } })
  .returning({ id: parents.id });

await db
  .insert(identifiantsPortail)
  .values({
    parentId: parent.id,
    portailEmail,
    mdpChiffre: chiffrer(motDePasse, parent.id),
    echecsConsecutifs: 0,
    derniereErreur: null,
    alerteEchecLe: null,
  })
  .onConflictDoUpdate({
    target: identifiantsPortail.parentId,
    set: {
      portailEmail,
      mdpChiffre: chiffrer(motDePasse, parent.id),
      echecsConsecutifs: 0,
      derniereErreur: null,
      alerteEchecLe: null,
    },
  });

await db
  .insert(rappels)
  .values({ parentId: parent.id, joursAvant, joursSilencieux })
  .onConflictDoUpdate({ target: rappels.parentId, set: { joursAvant, joursSilencieux } });

await db.delete(destinataires).where(eq(destinataires.parentId, parent.id));
await db.insert(destinataires).values(adresses.map((a) => ({ parentId: parent.id, email: a })));

console.log(`Compte ${email} pret (${parent.id})`);
console.log(`  destinataires : ${adresses.join(", ")}`);
console.log(`  rappels a J-  : ${joursAvant.join(", ")}`);
console.log(
  `  confirmations : ${joursAvant.filter((n) => !joursSilencieux.includes(n)).join(", ") || "aucune"}`,
);
process.exit(0);
