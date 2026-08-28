#!/usr/bin/env node
/**
 * Applique les migrations SQL de drizzle/ sur la base pointee par DATABASE_URL.
 *
 * A preferer a `drizzle-kit push` pour la production : push compare le schema
 * et decide seul des alterations, alors que les migrations sont des fichiers
 * versionnes, relus et rejouables a l'identique.
 *
 *   DATABASE_URL="postgres://...neon.tech/...?sslmode=require" node scripts/migrer.ts
 */

import { chargerEnv } from "./env.ts";

chargerEnv();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquante.");
  process.exit(2);
}

const { drizzle } = await import("drizzle-orm/postgres-js");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const postgres = (await import("postgres")).default;

// `max: 1` obligatoire pour les migrations : les verrous de migration doivent
// etre poses par une seule connexion.
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  console.log("Migrations appliquees.");
} finally {
  await sql.end();
}
process.exit(0);
