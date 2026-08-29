import assert from "node:assert/strict";
import { test } from "node:test";
import { analyser, estReserve, getPrestations, type Payload } from "../lib/portail/prestations.ts";
import { ErreurStructure, ErreurTemporaire } from "../lib/portail/auth.ts";
import { jourDepuisIso } from "../lib/portail/dates.ts";
import type { Session } from "../lib/portail/session.ts";
import type { ConfigPortail, Pointage } from "../lib/portail/types.ts";
import { nePasRejouer } from "../lib/reessayer.ts";
import { decider } from "../lib/service/decision.ts";

/**
 * Fixture calquee sur la structure observee en conditions reelles : pointages
 * indexes "<fkindividu>|<fkprestation>|<date>", prestations indexees par id.
 * Deux enfants, la cantine surveillee (RepE) et la garderie qui ne l'est pas.
 */
const config = (exclusions: string[] = []): ConfigPortail => ({
  email: "parent@exemple.fr",
  password: "x",
  bdd: "cantine2_argentiere",
  apiKey: "cantine2",
  dbId: "8089",
  typeId: "9",
  portail: "argentiere",
  prestation: /RepE|Repas enfant/i,
  exclusions: new Set(exclusions),
});

const pointage = (p: Partial<Pointage> & Pick<Pointage, "date" | "code_etat">): Pointage => ({
  fkprestation: 12,
  fkindividu: 1,
  type: "R",
  etat: 0,
  disabled: false,
  fkfacture: null,
  ...p,
});

function payload(pointages: Pointage[]): Payload {
  return {
    data: {
      pointages: Object.fromEntries(
        pointages.map((pt) => [`${pt.fkindividu}|${pt.fkprestation}|${pt.date}`, pt]),
      ),
      prestations: {
        12: { prestation: { code: "RepE", libelle: "Repas enfant" } },
        13: { prestation: { code: "Gmat", libelle: "Garderie matin" } },
      },
      individus: [
        { fkindividu: 1, prenom: "Lea" },
        { fkindividu: 2, prenom: "Noe" },
      ],
    },
  };
}

const lundi = jourDepuisIso("2026-09-07");
const dimanche = jourDepuisIso("2026-09-13");

test("classe chaque pointage selon son code d'etat", () => {
  const a = analyser(
    payload([
      pointage({ date: "2026-09-07", code_etat: "ETAT_BLOCAGE_RESERVE", etat: 3 }),
      pointage({ date: "2026-09-08", code_etat: "ETAT_FACTURE", etat: 104, fkfacture: 77 }),
      pointage({ date: "2026-09-10", code_etat: "ETAT_NON_RESERVE" }),
      // Mercredi et week-end : le portail les rend fermes et verrouilles, ce
      // qui permet de se passer d'un calendrier scolaire.
      pointage({ date: "2026-09-09", code_etat: "ETAT_PRESTATION_FERMEE", etat: 100, disabled: true }),
    ]),
    config(),
    lundi,
    dimanche,
  );

  assert.deepEqual(
    a.manquants.map((m) => `${m.enfant} ${m.date.toISOString().slice(0, 10)}`),
    ["Lea 2026-09-10"],
  );
  assert.equal(a.reserves.length, 2);
  assert.equal(a.bloques.length, 1);
  assert.deepEqual(a.inconnus, []);
});

test("un manquant est un couple (jour, enfant), pas un jour", () => {
  // Une reservation posee pour un seul enfant ne couvre pas la fratrie : c'est
  // la regle qui distingue ce service d'un simple coup d'oeil au calendrier.
  const a = analyser(
    payload([
      pointage({ date: "2026-09-08", fkindividu: 1, code_etat: "ETAT_RESERVE", etat: 1 }),
      pointage({ date: "2026-09-08", fkindividu: 2, code_etat: "ETAT_NON_RESERVE" }),
    ]),
    config(),
    lundi,
    dimanche,
  );

  assert.equal(a.manquants.length, 1);
  assert.equal(a.manquants[0].enfant, "Noe");
});

test("les manquants sortent tries par date puis par enfant", () => {
  const a = analyser(
    payload([
      pointage({ date: "2026-09-10", fkindividu: 2, code_etat: "ETAT_NON_RESERVE" }),
      pointage({ date: "2026-09-08", fkindividu: 2, code_etat: "ETAT_NON_RESERVE" }),
      pointage({ date: "2026-09-08", fkindividu: 1, code_etat: "ETAT_NON_RESERVE" }),
    ]),
    config(),
    lundi,
    dimanche,
  );

  assert.deepEqual(
    a.manquants.map((m) => `${m.date.toISOString().slice(0, 10)} ${m.enfant}`),
    ["2026-09-08 Lea", "2026-09-08 Noe", "2026-09-10 Noe"],
  );
});

test("un code hors liste blanche compte comme non reserve et est signale", () => {
  // Asymetrie voulue : une alerte en trop est benigne, une alerte manquante
  // fait rater le repas. Ne jamais inverser ce defaut.
  const a = analyser(
    payload([pointage({ date: "2026-09-08", code_etat: "ETAT_PRE_RESERVE", etat: 2 })]),
    config(),
    lundi,
    dimanche,
  );

  assert.equal(a.manquants.length, 1);
  assert.deepEqual(a.inconnus, ["ETAT_PRE_RESERVE"]);
  assert.ok(!estReserve(pointage({ date: "2026-09-08", code_etat: "ETAT_PRE_RESERVE" })));
});

test("un jour verrouille n'est jamais un manquant", () => {
  // Le parent ne peut rien y faire : le signaler serait du bruit, et lui
  // demanderait une action impossible.
  const a = analyser(
    payload([
      pointage({ date: "2026-09-08", code_etat: "ETAT_BLOCAGE_DEPASSE", etat: 105, disabled: true }),
      pointage({ date: "2026-09-09", code_etat: "ETAT_BLOCAGE", disabled: true }),
    ]),
    config(),
    lundi,
    dimanche,
  );

  assert.equal(a.manquants.length, 0);
  assert.equal(a.bloques.length, 2);
});

test("CANTINE_EXCLUSIONS retire un jour des manquants", () => {
  // Sortie scolaire avec pique-nique : le portail l'ignore, pas nous.
  const a = analyser(
    payload([
      pointage({ date: "2026-09-08", code_etat: "ETAT_NON_RESERVE" }),
      pointage({ date: "2026-09-10", code_etat: "ETAT_NON_RESERVE" }),
    ]),
    config(["2026-09-08"]),
    lundi,
    dimanche,
  );

  assert.deepEqual(
    a.manquants.map((m) => m.date.toISOString().slice(0, 10)),
    ["2026-09-10"],
  );
});

test("seules la prestation surveillee et la fenetre demandee sont retenues", () => {
  const a = analyser(
    payload([
      pointage({ date: "2026-09-08", code_etat: "ETAT_NON_RESERVE" }),
      // Garderie : autre prestation, autre delai, hors perimetre.
      pointage({ date: "2026-09-08", fkprestation: 13, code_etat: "ETAT_NON_RESERVE" }),
      // Semaine suivante : hors de la fenetre demandee.
      pointage({ date: "2026-09-15", code_etat: "ETAT_NON_RESERVE" }),
    ]),
    config(),
    lundi,
    dimanche,
  );

  assert.equal(a.retenus.length, 1);
  assert.equal(a.manquants.length, 1);
  assert.equal(a.manquants[0].prestation, "Repas enfant");
});

test("une fenetre sans pointage se lit a retenus, sans lever", () => {
  // Vacances : le payload reste valide, il n'a simplement rien a dire. C'est
  // decider() qui en tire le silence, pas une exception.
  const a = analyser(payload([]), config(), lundi, dimanche);
  assert.equal(a.retenus.length, 0);
  assert.equal(a.manquants.length, 0);
});

test("un payload sans la prestation surveillee est une erreur de structure", () => {
  assert.throws(
    () => analyser({ data: { pointages: {}, prestations: {}, individus: [] } }, config(), lundi, dimanche),
    /Aucune prestation ne correspond/,
  );
});

test("un payload sans data.pointages est une erreur de structure", () => {
  // Les prestations sont bien la : c'est le dictionnaire des pointages qui
  // manque, donc le portail a change de forme. Rejouer n'y changerait rien.
  const sansPointages = {
    data: {
      prestations: { 12: { prestation: { code: "RepE", libelle: "Repas enfant" } } },
      individus: [],
    },
  };
  assert.throws(
    () => analyser(sansPointages, config(), lundi, dimanche),
    /Structure inattendue : data.pointages absent/,
  );
});

test("une semaine de vacances ne se confirme pas, malgre ses pointages", () => {
  // Le piege que ce test garde : pendant les vacances le portail ne renvoie pas
  // une fenetre vide, il renvoie chaque jour en ETAT_PRESTATION_FERMEE et
  // `disabled`. Se fier au nombre de pointages ferait donc croire a une semaine
  // pleine et enverrait a toutes les familles un "Rien a faire, tout est
  // reserve" annoncant zero repas.
  const fermes = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"].map(
    (date) => pointage({ date, code_etat: "ETAT_PRESTATION_FERMEE", etat: 100, disabled: true }),
  );
  const a = analyser(payload(fermes), config(), lundi, dimanche);

  assert.equal(a.retenus.length, 5);
  assert.equal(a.manquants.length, 0);
  assert.equal(a.reserves.length, 0);
  assert.equal(
    decider({
      manquants: a.manquants.length,
      reserves: a.reserves.length,
      joursRestants: 4,
      joursSilencieux: [],
    }),
    "silence",
  );
});

/** Session reduite a ce que lit getPrestations, sans sortir sur le reseau. */
const sessionQuiRepond = (statut: number, corps: string): Session =>
  ({ go: async () => new Response(corps, { status: statut }) }) as unknown as Session;

test("un 429 sur les prestations est temporaire et n'est jamais rejoue", async () => {
  // Insister prolonge le blocage par IP, qui frappe ensuite des comptes valides.
  await assert.rejects(
    () => getPrestations(config(), sessionQuiRepond(429, "trop de requetes"), "b", lundi, dimanche),
    (e: unknown) => {
      assert.ok(e instanceof ErreurTemporaire);
      assert.equal(e.statut, 429);
      assert.ok(nePasRejouer(e));
      return true;
    },
  );
});

test("un 5xx sur les prestations est temporaire et merite un nouvel essai", async () => {
  await assert.rejects(
    () => getPrestations(config(), sessionQuiRepond(503, "maintenance"), "b", lundi, dimanche),
    (e: unknown) => {
      assert.ok(e instanceof ErreurTemporaire);
      assert.ok(!nePasRejouer(e));
      return true;
    },
  );
});

test("un statut inattendu sur les prestations n'est pas rejoue", async () => {
  // 401, 403, 404 rendront la meme chose au coup suivant, et chaque tentative
  // refait les quatre sauts de connexion : trois essais coutent douze requetes
  // depuis la meme IP pour rien, ce qui pousse vers le 429 qu'on evite.
  await assert.rejects(
    () => getPrestations(config(), sessionQuiRepond(401, "non autorise"), "b", lundi, dimanche),
    (e: unknown) => {
      assert.ok(e instanceof ErreurStructure);
      assert.ok(nePasRejouer(e));
      return true;
    },
  );
});
