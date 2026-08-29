import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BREVO_API_KEY = "cle-de-test";
process.env.MAIL_EXPEDITEUR = "alerte@exemple.fr";
const { envoyerBrevo } = await import("../lib/mail/brevo.ts");

const message = (destinataires: string[]) => ({
  destinataires,
  objet: "objet",
  corps: "texte",
  html: "<p>html</p>",
});

/**
 * Repond un statut par adresse visee, sans jamais sortir sur le reseau. Rend la
 * fonction de restauration, a appeler en fin de test.
 */
function fetchSimule(parAdresse: Record<string, number>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const corps = JSON.parse(String(init?.body));
    return new Response("{}", { status: parAdresse[corps.to[0].email] ?? 201 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Les envois partiels definitifs ecrivent sur console.error, ce qui est voulu. */
function sansJournal(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

test("un envoi qui aboutit partout ne leve pas", async () => {
  const rendre = fetchSimule({});
  try {
    await envoyerBrevo(message(["a@exemple.fr", "b@exemple.fr"]));
  } finally {
    rendre();
  }
});

test("un echec sur toutes les adresses leve", async () => {
  const rendre = fetchSimule({ "a@exemple.fr": 500, "b@exemple.fr": 500 });
  try {
    await assert.rejects(
      () => envoyerBrevo(message(["a@exemple.fr", "b@exemple.fr"])),
      /aucun envoi n'a abouti/,
    );
  } finally {
    rendre();
  }
});

test("un echec partiel rattrapable leve, pour liberer le verrou anti-doublon", async () => {
  // C'est le point important : l'appelant a pose la ligne d'envoi AVANT
  // d'expedier. Se taire ici la laisserait en place, le rejeu du soir
  // conclurait que le message est parti, et l'adresse en echec perdrait
  // definitivement son rappel — le seul echec vraiment grave de ce service.
  const rendre = fetchSimule({ "b@exemple.fr": 503 });
  try {
    await assert.rejects(
      () => envoyerBrevo(message(["a@exemple.fr", "b@exemple.fr"])),
      /envoi partiel rattrapable/,
    );
  } finally {
    rendre();
  }
});

test("un echec partiel definitif ne leve pas", async () => {
  // Une adresse durablement refusee (faute de frappe) rendra la meme chose
  // demain : lever ferait renvoyer le message a tout le foyer a chaque passage.
  const rendre = fetchSimule({ "b@exemple.fr": 400 });
  const muet = sansJournal();
  try {
    await envoyerBrevo(message(["a@exemple.fr", "b@exemple.fr"]));
  } finally {
    muet();
    rendre();
  }
});

test("un 429 partiel est traite comme rattrapable", async () => {
  const rendre = fetchSimule({ "b@exemple.fr": 429 });
  try {
    await assert.rejects(
      () => envoyerBrevo(message(["a@exemple.fr", "b@exemple.fr"])),
      /envoi partiel rattrapable/,
    );
  } finally {
    rendre();
  }
});
