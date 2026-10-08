import assert from "node:assert/strict";
import { test } from "node:test";
import { signauxDe } from "../lib/supervision/signaux.ts";
import type { ResultatCron } from "../lib/service/verification.ts";

/** Un cycle nominal : tout le monde traite, rien a signaler. */
const cycle = (surcharge: Partial<ResultatCron> = {}): ResultatCron => ({
  aujourdhui: "2026-09-21",
  echeance: "2026-09-21",
  semaineVisee: "2026-09-28",
  joursRestants: 0,
  traites: [],
  nonTraites: 0,
  interroges: 0,
  dureeMs: 1200,
  ...surcharge,
});

const parent = (surcharge: Partial<ResultatCron["traites"][number]>) => ({
  parentId: "p1",
  email: "parent@exemple.fr",
  statut: "notifie" as const,
  ...surcharge,
});

const empreintes = (r: ResultatCron) => signauxDe(r).map((s) => s.empreinte);

test("un cycle sans incident ne signale rien", () => {
  // Le cas de tous les jours. Une supervision qui parle quand tout va bien
  // s'use et finit ignoree.
  assert.deepEqual(signauxDe(cycle({ traites: [parent({})] })), []);
});

test("des familles non examinees sont une alerte, pas une statistique", () => {
  const [signal, ...reste] = signauxDe(cycle({ nonTraites: 3, traites: [parent({})] }));
  assert.equal(reste.length, 0);
  assert.equal(signal?.empreinte, "cycle-non-traites");
  assert.equal(signal?.niveau, "error");
  assert.equal(signal?.contexte.nonTraites, 3);
});

test("une fenetre depassee remonte en erreur : l'alerte ne partirait jamais", () => {
  // C'est le signal qui denoncerait la regle « veille minuit » du periscolaire,
  // deduite et jamais confrontee au portail.
  const r = cycle({
    traites: [
      parent({ statut: "notifie", depassees: ["matin"] }),
      parent({ parentId: "p2", statut: "notifie", depassees: ["matin", "soir"] }),
    ],
  });
  const [signal] = signauxDe(r);
  assert.equal(signal?.empreinte, "fenetre-depassee");
  assert.equal(signal?.niveau, "error");
  // Dedoublonne : deux familles touchees par « matin » font un seul signal.
  assert.deepEqual(signal?.contexte.surveillances, ["matin", "soir"]);
});

test("un changement de structure est une erreur, une panne passagere un avertissement", () => {
  // `statut` les confond toutes deux sous `echec_technique` : c'est `nature`
  // qui tranche, et la difference est celle entre « reprendre le parsing » et
  // « attendre ».
  const structure = signauxDe(
    cycle({ traites: [parent({ statut: "echec_technique", nature: "structure", detail: "JSON illisible" })] }),
  );
  assert.equal(structure[0]?.empreinte, "portail-structure");
  assert.equal(structure[0]?.niveau, "error");
  assert.equal(structure[0]?.contexte.exemple, "JSON illisible");

  const temporaire = signauxDe(
    cycle({ traites: [parent({ statut: "echec_technique", nature: "temporaire", detail: "502" })] }),
  );
  assert.equal(temporaire[0]?.empreinte, "portail-indisponible");
  assert.equal(temporaire[0]?.niveau, "warning");
});

test("des identifiants refuses ne produisent aucun signal", () => {
  // Le parent a change son mot de passe portail : le service le desactive et
  // lui ecrit. C'est le fonctionnement normal, pas une panne a superviser.
  assert.deepEqual(
    signauxDe(
      cycle({ traites: [parent({ statut: "identifiants_invalides", nature: "identifiants" })] }),
    ),
    [],
  );
});

test("un echec d'expedition avertit sans alarmer", () => {
  // Le verrou est libere, le passage du soir retentera.
  const [signal] = signauxDe(cycle({ traites: [parent({ statut: "echec_envoi" })] }));
  assert.equal(signal?.empreinte, "envoi-echoue");
  assert.equal(signal?.niveau, "warning");
  assert.deepEqual(signal?.contexte.parentIds, ["p1"]);
});

test("les signaux de silence invisible remontent", () => {
  const r = cycle({
    traites: [parent({ absentes: ["matin"], inconnus: ["ETAT_PREPARATION"] })],
  });
  assert.deepEqual(empreintes(r), ["surveillance-absente", "etat-non-repertorie"]);
  assert.ok(signauxDe(r).every((s) => s.niveau === "warning"));
});

test("les erreurs precedent les avertissements", () => {
  // L'ordre est ce qu'on lit en premier dans une liste d'issues.
  const r = cycle({
    nonTraites: 1,
    traites: [
      parent({ statut: "echec_envoi", inconnus: ["ETAT_X"] }),
      parent({ parentId: "p2", statut: "echec_technique", nature: "structure" }),
    ],
  });
  assert.deepEqual(empreintes(r), [
    "cycle-non-traites",
    "portail-structure",
    "envoi-echoue",
    "etat-non-repertorie",
  ]);
});

test("aucun signal ne transporte d'adresse", () => {
  // Les parents portent une adresse dans `traites` ; elle ne doit jamais
  // franchir la frontiere du signal. Seul le parent_id pseudonyme passe.
  const r = cycle({
    nonTraites: 2,
    traites: [
      parent({ statut: "echec_technique", nature: "structure", detail: "boum" }),
      parent({ parentId: "p2", statut: "echec_envoi" }),
      parent({ parentId: "p3", statut: "notifie", absentes: ["soir"], inconnus: ["ETAT_X"] }),
    ],
  });
  const serialise = JSON.stringify(signauxDe(r));
  assert.doesNotMatch(serialise, /@/);
  assert.doesNotMatch(serialise, /exemple\.fr/);
});

test("une erreur echappee au cycle ne reste pas silencieuse", () => {
  // Le filet de derniere instance de `executerCron` posait un `echec_technique`
  // sans nature : aucun signal n'en sortait, et le parent ne recevait meme pas
  // de mail d'echec technique puisque ce chemin court-circuite `alerter()`.
  const [signal, ...reste] = signauxDe(
    cycle({
      traites: [parent({ statut: "echec_technique", nature: "inconnue", detail: "db timeout" })],
    }),
  );
  assert.equal(reste.length, 0);
  assert.equal(signal?.empreinte, "erreur-non-rattrapee");
  assert.equal(signal?.niveau, "error");
  assert.equal(signal?.contexte.exemple, "db timeout");
});

test("une session refusee avertit au lieu d'accuser le portail d'avoir change", () => {
  // Classee `temporaire` depuis le 2026-10-08 : le signal doit etre
  // « indisponible » (warning), pas « ne repond plus ce qu'on sait lire ».
  const [signal] = signauxDe(
    cycle({ traites: [parent({ statut: "echec_technique", nature: "temporaire", detail: "401" })] }),
  );
  assert.equal(signal?.empreinte, "portail-indisponible");
  assert.equal(signal?.niveau, "warning");
});
