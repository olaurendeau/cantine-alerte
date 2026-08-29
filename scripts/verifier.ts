#!/usr/bin/env node
/**
 * CLI de diagnostic. Rejoue la logique de l'application sur la lib partagee
 * (lib/portail), sans base de donnees ni envoi de mail : sert de test de
 * non-regression face au POC d'origine et d'outil d'investigation quand le
 * portail change.
 *
 *   node scripts/verifier.ts                  verifie la semaine visee
 *   node scripts/verifier.ts --dump           JSON brut + rapport de structure
 *   node scripts/verifier.ts --verbose        trace chaque etape HTTP
 *   node scripts/verifier.ts --semaines 3     elargit la fenetre examinee
 *   node scripts/verifier.ts --date 2026-09-08,2026-09-14   simule des dates
 */

import { readFileSync } from "node:fs";
import {
  ajouter,
  analyser,
  aujourdhuiParis,
  configDepuisEnv,
  getPrestations,
  iso,
  joursRestants,
  jourDepuisIso,
  login,
  nouvelleSession,
  prochaineEcheance,
  rapportStructure,
  semaineVisee,
  urlPortail,
} from "../lib/portail/index.ts";
import type { Logger } from "../lib/portail/index.ts";
import { mailRappel } from "../lib/mail/messages.ts";

const AIDE = `Usage : node scripts/verifier.ts [options]

  --dump              affiche le JSON brut des prestations et un rapport de structure
  --verbose, -v       trace chaque etape HTTP et le detail du parsing
  --semaines N        nombre de semaines examinees a partir de la semaine visee (defaut 1)
  --date D1,D2,...    simule une ou plusieurs dates du jour (YYYY-MM-DD). Plusieurs
                      dates = une seule requete couvrant l'union des fenetres.
  --help, -h          cette aide

Configuration : fichier .env a la racine (CANTINE_EMAIL, CANTINE_PASSWORD requis).`;

class ErreurConfig extends Error {}

function chargerEnv() {
  let texte: string;
  try {
    texte = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return;
  }
  for (const ligne of texte.split("\n")) {
    const t = ligne.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const cle = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q)) val = val.slice(1, -1);
    if (!(cle in process.env)) process.env[cle] = val;
  }
}

function lireArgs(argv: string[]) {
  const o = { dump: false, verbose: false, semaines: 1, dates: [null] as (string | null)[], aide: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dump") o.dump = true;
    else if (a === "--verbose" || a === "-v") o.verbose = true;
    else if (a === "--semaines") o.semaines = Number(argv[++i]);
    else if (a === "--date") o.dates = (argv[++i] ?? "").split(",").map((s) => s.trim());
    else if (a === "--help" || a === "-h") o.aide = true;
    else throw new ErreurConfig(`Option inconnue : ${a}\n\n${AIDE}`);
  }
  if (!Number.isInteger(o.semaines) || o.semaines < 1) {
    throw new ErreurConfig("--semaines attend un entier >= 1");
  }
  for (const d of o.dates) {
    if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new ErreurConfig(`--date attend des dates YYYY-MM-DD separees par des virgules : ${d}`);
    }
  }
  if (o.dump && o.dates.length > 1) throw new ErreurConfig("--dump ne gere qu'une seule date");
  return o;
}

async function main() {
  const opts = lireArgs(process.argv.slice(2));
  if (opts.aide) {
    console.log(AIDE);
    return;
  }

  chargerEnv();
  const cfg = configDepuisEnv(process.env);
  const trace: Logger = opts.verbose ? (...a) => console.error("  .", ...a) : () => {};

  const scenarios = opts.dates.map((d) => {
    const aujourdhui = d ? jourDepuisIso(d) : aujourdhuiParis();
    const echeance = prochaineEcheance(aujourdhui);
    const debut = semaineVisee(echeance);
    return {
      aujourdhui,
      echeance,
      restants: joursRestants(aujourdhui, echeance),
      debut,
      fin: ajouter(debut, opts.semaines * 7 - 1),
    };
  });

  // Une seule requete couvrant l'union des fenetres : simuler plusieurs dates
  // ne doit pas multiplier les allers-retours au portail.
  const debutGlobal = scenarios.reduce((a, s) => (s.debut < a ? s.debut : a), scenarios[0].debut);
  const finGlobale = scenarios.reduce((a, s) => (s.fin > a ? s.fin : a), scenarios[0].fin);

  const session = nouvelleSession(trace);
  const bearer = await login(cfg, session, trace);
  const payload = await getPrestations(cfg, session, bearer, debutGlobal, finGlobale, trace);

  if (opts.dump) {
    const s = scenarios[0];
    console.log(JSON.stringify(payload, null, 2));
    console.error(`\n${rapportStructure(analyser(payload, cfg, s.debut, s.fin))}`);
    return;
  }

  for (const [i, s] of scenarios.entries()) {
    console.log(
      `${i ? "\n" : ""}Aujourd'hui ${iso(s.aujourdhui)} | echeance ${iso(s.echeance)} minuit ` +
        `(J-${s.restants}) | semaine visee ${iso(s.debut)}`,
    );
    const analyse = analyser(payload, cfg, s.debut, s.fin);
    if (opts.verbose) console.error(rapportStructure(analyse));

    // Avant tout raccourci : un etat non repertorie doit se voir meme sur une
    // fenetre par ailleurs vide, c'est le seul signal qui annonce un code a
    // classer.
    if (analyse.inconnus.length) {
      console.error(
        `Attention : etat(s) non repertorie(s) ${analyse.inconnus.join(", ")}, traite(s) comme ` +
          "non reserve(s). A classer dans ETATS_RESERVES ou ETATS_NON_RESERVES.",
      );
    }
    // Ni repas reserve, ni repas a reserver. Compter les pointages serait faux :
    // pendant les vacances le portail en renvoie tout de meme, en
    // ETAT_PRESTATION_FERMEE et `disabled`.
    if (analyse.reserves.length === 0 && analyse.manquants.length === 0) {
      console.log(
        `Rien a reserver entre ${iso(s.debut)} et ${iso(s.fin)}, et aucune reservation posee : ` +
          "periode fermee cote portail (vacances), ou hors annee scolaire.",
      );
      continue;
    }

    console.log(
      `${analyse.reserves.length} reservation(s) deja posee(s), ${analyse.manquants.length} ` +
        `manquante(s)` +
        (analyse.bloques.length ? `, ${analyse.bloques.length} jour(s) non reservable(s)` : ""),
    );
    if (analyse.manquants.length === 0) {
      console.log("OK : rien a signaler, aucune notification");
      continue;
    }
    for (const m of analyse.manquants) {
      console.log(`A reserver : ${iso(m.date)} ${m.enfant} (${m.prestation})`);
    }
    const mail = mailRappel({
      manquants: analyse.manquants,
      semaine: s.debut,
      echeance: s.echeance,
      joursRestants: s.restants,
      urgent: s.restants === 0,
      liens: {
        reservation: urlPortail(cfg),
        reglages: `${process.env.APP_URL ?? "http://localhost:3000"}/reglages`,
      },
    });
    console.log(`\n${"=".repeat(64)}\nObjet : ${mail.objet}\n${"-".repeat(64)}`);
    console.log(mail.texte);
    console.log("=".repeat(64));
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(e instanceof ErreurConfig ? 2 : 1);
});
