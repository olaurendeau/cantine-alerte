import assert from "node:assert/strict";
import { test } from "node:test";
import { passeParLePooler, urlApplication, urlMigration } from "../lib/db/url.ts";

const POOLED = "postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require";
const DIRECTE = "postgres://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=require";

test("l'application prend DATABASE_URL", () => {
  assert.equal(urlApplication({ DATABASE_URL: POOLED }), POOLED);
});

test("les migrations preferent la connexion directe de l'integration Neon", () => {
  // DATABASE_URL (pooled) est presente, mais ne doit pas etre choisie tant
  // qu'une URL directe existe.
  assert.equal(
    urlMigration({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECTE }),
    DIRECTE,
  );
  assert.equal(
    urlMigration({ DATABASE_URL: POOLED, POSTGRES_URL_NON_POOLING: DIRECTE }),
    DIRECTE,
  );
});

test("une surcharge explicite prime sur tout", () => {
  assert.equal(
    urlMigration({ DATABASE_URL_MIGRATION: DIRECTE, DATABASE_URL_UNPOOLED: POOLED }),
    DIRECTE,
  );
});

test("une reference non resolue est signalee clairement", () => {
  // Vercel ne remplace pas "$AUTRE_VARIABLE" dans la valeur d'une variable :
  // sans ce controle, postgres.js leve un "Invalid URL" qui n'oriente pas.
  assert.throws(
    () => urlMigration({ DATABASE_URL_MIGRATION: "$POSTGRES_URL_NON_POOLING" }),
    /ne resout pas les references/,
  );
  assert.throws(() => urlApplication({ DATABASE_URL: "${DATABASE_URL_UNPOOLED}" }), /litteralement/);
});

test("l'absence totale d'URL donne un message actionnable", () => {
  assert.throws(() => urlApplication({}), /Variables essayees/);
});

test("le pooler est reconnu", () => {
  assert.ok(passeParLePooler(POOLED));
  assert.ok(!passeParLePooler(DIRECTE));
});
