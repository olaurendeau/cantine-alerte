#!/usr/bin/env node
/**
 * Associe un compte au portail malgre le code 2FA : connexion avec le mot de
 * passe enregistre, saisie du code recu par mail, puis conservation chiffree
 * de l'appareil de confiance qui en dispense le cron pendant 30 jours.
 *
 *   node scripts/associer.ts --compte moi@exemple.fr
 *   node scripts/associer.ts --compte moi@exemple.fr --code-fichier /tmp/code.txt
 *   node scripts/associer.ts --compte moi@exemple.fr --mot-de-passe-env
 *
 * `--compte` est l'adresse de connexion au service (`parents.email`), pas celle
 * du portail. Le code est lu sur l'entree standard, ou dans le fichier designe
 * (surveille jusqu'a son apparition, puis efface) : c'est ce qui permet de
 * lancer l'outil dans un conteneur sans terminal interactif.
 *
 * ⚠️ Ecrit dans la base designee par DATABASE_URL, chiffre avec
 * CANTINE_CLE_CHIFFREMENT : contre la prod, il faut LA cle de la prod, sans
 * quoi le cron ne pourra pas dechiffrer l'appareil. Chaque lancement envoie un
 * code au parent.
 *
 * `--mot-de-passe-env` prend le mot de passe du portail dans CANTINE_PASSWORD
 * au lieu de la base, et le rechiffre avec la cle courante. C'est le chemin de
 * rotation de CANTINE_CLE_CHIFFREMENT : une cle perdue rend `mdp_chiffre`
 * illisible, et l'ecran des reglages refuse d'enregistrer des identifiants
 * tant que le compte n'a pas d'appareil. L'adresse portail reste celle de la
 * base ; CANTINE_EMAIL, s'il est pose, doit lui correspondre.
 *
 * N'affiche jamais ni le mot de passe ni la valeur du cookie.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { eq } from "drizzle-orm";
import { chargerEnv } from "./env.ts";

chargerEnv();

const { chiffrer, dechiffrer, VERSION_CLE_COURANTE } = await import("../lib/crypto.ts");
const { db } = await import("../lib/db/index.ts");
const { identifiantsPortail, parents } = await import("../lib/db/schema.ts");
const { ErreurCodeRefuse, configDepuisEnv, demanderCode, nouvelleSession, validerCode } =
  await import("../lib/portail/index.ts");

function arg(nom: string): string | undefined {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const compte = arg("compte")?.trim().toLowerCase();
if (!compte) {
  console.error("Usage : node scripts/associer.ts --compte <email du compte> [--code-fichier <chemin>]");
  process.exit(2);
}
const fichierCode = arg("code-fichier");
const verbeux = process.argv.includes("--verbose");
const motDePasseEnv = process.argv.includes("--mot-de-passe-env");

/**
 * Le code arrive ~15 min apres la demande et vaut 60 min ; la session Laravel
 * en tient 120. 55 min laissent de la marge des deux cotes.
 */
const ATTENTE_MAX_MS = 55 * 60_000;
const TENTATIVES = 3;

const [ligne] = await db
  .select({
    parentId: parents.id,
    portailEmail: identifiantsPortail.portailEmail,
    mdpChiffre: identifiantsPortail.mdpChiffre,
  })
  .from(parents)
  .innerJoin(identifiantsPortail, eq(identifiantsPortail.parentId, parents.id))
  .where(eq(parents.email, compte));

if (!ligne) {
  console.error(`Aucun compte ${compte} avec des identifiants portail dans cette base.`);
  process.exit(1);
}

function motDePasse(): string {
  if (!motDePasseEnv) return dechiffrer(ligne.mdpChiffre, ligne.parentId);
  const mdp = process.env.CANTINE_PASSWORD;
  if (!mdp) {
    console.error("--mot-de-passe-env : CANTINE_PASSWORD est vide.");
    process.exit(2);
  }
  const email = process.env.CANTINE_EMAIL?.trim().toLowerCase();
  if (email && email !== ligne.portailEmail.trim().toLowerCase()) {
    console.error("--mot-de-passe-env : CANTINE_EMAIL ne correspond pas a l'adresse portail en base.");
    process.exit(2);
  }
  return mdp;
}
const password = motDePasse();
const cfg = configDepuisEnv(process.env, { email: ligne.portailEmail, password });
const trace = verbeux ? (...a: unknown[]) => console.error("  ·", ...a) : () => {};
// Toute l'association dans une seule session : le code n'est valable que pour
// la session Laravel qui l'a demande. Le budget par defaut (45 s) est fait pour
// le cron, pas pour attendre un mail.
const session = nouvelleSession(trace, { budgetMs: ATTENTE_MAX_MS + 5 * 60_000 });

const lireLigne = (invite: string) =>
  new Promise<string>((ok) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(invite, (r) => {
      rl.close();
      ok(r);
    });
  });

async function lireCode(): Promise<string | null> {
  if (!fichierCode) return (await lireLigne("Code recu par mail : ")).replace(/\D/g, "") || null;
  if (existsSync(fichierCode)) rmSync(fichierCode);
  console.log(`En attente du code dans ${fichierCode} (55 min max)...`);
  const fin = Date.now() + ATTENTE_MAX_MS;
  while (Date.now() < fin) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!existsSync(fichierCode)) continue;
    const code = readFileSync(fichierCode, "utf8").replace(/\D/g, "");
    rmSync(fichierCode);
    if (code) return code;
  }
  return null;
}

console.log(`Compte ${ligne.parentId} : connexion au portail...`);
const demande = await demanderCode(cfg, session, trace);
if (demande.etat === "connecte") {
  console.log("Le portail n'a pas demande de code : rien a associer.");
  process.exit(0);
}
console.log(
  "Le portail a envoye un code a l'adresse du compte portail. Il peut mettre une quinzaine " +
    "de minutes a arriver.",
);

let attente = demande.attente;
let obtenu: Awaited<ReturnType<typeof validerCode>> | null = null;
for (let essai = 1; essai <= TENTATIVES && !obtenu; essai++) {
  const code = await lireCode();
  if (!code) {
    console.error("Aucun code saisi dans le delai : abandon, rien n'a ete enregistre.");
    process.exit(1);
  }
  try {
    obtenu = await validerCode(cfg, session, attente, code, trace);
  } catch (e) {
    if (!(e instanceof ErreurCodeRefuse)) throw e;
    console.error(`Code refuse (${e.messagePortail ?? "sans message"}), essai ${essai}/${TENTATIVES}.`);
    attente = e.attente;
  }
}
if (!obtenu) {
  console.error("Trois codes refuses : abandon, rien n'a ete enregistre.");
  process.exit(1);
}

const { appareil } = obtenu;
// Une connexion complete vient de reussir : meme remise a zero qu'un
// enregistrement d'identifiants, et le compte suspendu repart.
await db
  .update(identifiantsPortail)
  .set({
    // Le mot de passe vient de reussir la connexion : le rechiffrer avec la
    // cle courante est sans risque, et c'est tout l'objet de la rotation.
    ...(motDePasseEnv
      ? { mdpChiffre: chiffrer(password, ligne.parentId), cleVersion: VERSION_CLE_COURANTE }
      : {}),
    appareilChiffre: chiffrer(appareil.valeur, ligne.parentId),
    appareilExpireLe: appareil.expireLe,
    verifieLe: new Date(),
    echecsConsecutifs: 0,
    refusConsecutifs: 0,
    derniereErreur: null,
    alerteEchecLe: null,
  })
  .where(eq(identifiantsPortail.parentId, ligne.parentId));
await db.update(parents).set({ actif: true }).where(eq(parents.id, ligne.parentId));

console.log(
  `Appareil de confiance enregistre, valable jusqu'au ${appareil.expireLe?.toISOString() ?? "(date inconnue)"}.`,
);
process.exit(0);
