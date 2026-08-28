#!/usr/bin/env node
/**
 * Applique les migrations SQL de drizzle/ sur la base ciblee.
 *
 * Lance a chaque deploiement Vercel via le script `vercel-build`, et a la main
 * en local. A preferer a `drizzle-kit push` : push compare le schema et decide
 * seul des alterations, alors que les migrations sont des fichiers versionnes,
 * relus et rejouables a l'identique.
 *
 *   npm run db:migrer
 *   DATABASE_URL="postgres://..." node scripts/migrer.ts
 */

import { chargerEnv } from "./env.ts";

chargerEnv();

const { urlMigration, passeParLePooler } = await import("../lib/db/url.ts");

let url: string;
try {
  // Resout DATABASE_URL_MIGRATION, puis les variables que l'integration Neon
  // pose d'elle-meme (DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING).
  url = urlMigration();
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

if (passeParLePooler(url)) {
  console.warn(
    "Attention : cette URL passe par le pooler Neon (hote en -pooler).\n" +
      "Les migrations demandent la connexion DIRECTE : utilisez DATABASE_URL_UNPOOLED.\n" +
      "Le pooler reste le bon choix pour l'application elle-meme.\n",
  );
}

const { drizzle } = await import("drizzle-orm/postgres-js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const postgres = (await import("postgres")).default;

// `max: 1` obligatoire : le verrou consultatif et les migrations doivent
// partager la meme session.
const sql = postgres(url, { max: 1 });

/**
 * Deux deploiements concurrents appliqueraient les memes migrations en meme
 * temps et la seconde echouerait sur un "relation already exists", faisant
 * echouer le build. Le verrou consultatif les serialise : le second attend,
 * puis constate qu'il n'y a plus rien a appliquer.
 */
const VERROU = 827_412_355;

try {
  await sql`select pg_advisory_lock(${VERROU})`;
  try {
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });

    // Relire l'etat reel plutot que se fier au silence. Drizzle tient son
    // journal dans un schema `drizzle` distinct : si l'on a vide `public` sans
    // toucher a ce journal, il se croit a jour, ne rejoue rien et annonce un
    // succes sur une base vide. On decouvrirait le probleme au premier rappel.
    const tables = await sql<{ nom: string }[]>`
      select tablename as nom from pg_tables
      where schemaname = 'public' order by tablename
    `;
    const noms = tables.map((t) => t.nom);
    const attendues = [
      "destinataires",
      "envois",
      "identifiants_portail",
      "liens_magiques",
      "parents",
      "rappels",
    ];
    const manquantes = attendues.filter((t) => !noms.includes(t));

    if (manquantes.length) {
      console.error(
        `Echec : ${manquantes.length} table(s) manquante(s) apres migration : ` +
          `${manquantes.join(", ")}.\n` +
          "Le journal de migrations vit dans le schema `drizzle`, separe de `public`. " +
          "Si `public` a ete vide sans lui, drizzle se croit a jour et ne rejoue rien.\n" +
          "Pour repartir de zero :\n" +
          '  psql "$DATABASE_URL" -c \'DROP SCHEMA IF EXISTS public CASCADE; ' +
          "DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;'",
      );
      process.exitCode = 1;
    } else {
      console.log(`Migrations appliquees. ${noms.length} table(s) : ${noms.join(", ")}`);
    }
  } finally {
    await sql`select pg_advisory_unlock(${VERROU})`;
  }
} finally {
  await sql.end();
}
process.exit(process.exitCode ?? 0);
