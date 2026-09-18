"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fermerSession, sessionCourante } from "../../lib/auth/session.ts";
import { jourDepuisIso } from "../../lib/portail/dates.ts";
import { aujourdhuiParis } from "../../lib/portail/dates.ts";
import {
  enregistrerDestinataires,
  enregistrerIdentifiants,
  enregistrerRappels,
  enregistrerSurveillance,
  envoyerMailTest,
  mettreEnPause,
  reprendreAlertes,
  semaineAMettreEnPause,
  verifierMaintenant,
} from "../../lib/service/reglages.ts";

async function exigerSession() {
  const session = await sessionCourante();
  if (!session) redirect("/connexion");
  return session;
}

/** Ne retourne jamais : `redirect` interrompt le rendu en levant. */
function retour(params: Record<string, string>): never {
  revalidatePath("/reglages");
  redirect(`/reglages?${new URLSearchParams(params)}`);
}

export async function actionIdentifiants(formData: FormData) {
  const session = await exigerSession();
  const portailEmail = String(formData.get("portailEmail") ?? "").trim();
  const motDePasse = String(formData.get("motDePasse") ?? "");

  if (!portailEmail || !motDePasse) {
    retour({ erreur: "Renseignez l'identifiant et le mot de passe du portail." });
  }

  const r = await enregistrerIdentifiants(session.parentId, portailEmail, motDePasse);
  retour(r.ok ? { succes: "Identifiants verifies et enregistres." } : { erreur: r.message });
}

export async function actionDestinataires(formData: FormData) {
  const session = await exigerSession();
  const emails = String(formData.get("destinataires") ?? "")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (emails.length === 0) {
    retour({ erreur: "Indiquez au moins une adresse destinataire." });
  }
  await enregistrerDestinataires(session.parentId, emails);
  retour({ succes: `${emails.length} destinataire(s) enregistre(s).` });
}

export async function actionRappels(formData: FormData) {
  const session = await exigerSession();
  const jours = formData.getAll("jours").map((v) => Number(v));
  const confirmations = formData.getAll("confirmation").map((v) => Number(v));
  await enregistrerRappels(session.parentId, jours, confirmations);

  if (jours.length === 0) {
    retour({ succes: "Rappels desactives : aucun jour selectionne." });
  }
  const muets = jours.filter((n) => !confirmations.includes(n)).length;
  retour({
    succes:
      `${jours.length} jour(s) de rappel enregistre(s)` +
      (muets ? `, dont ${muets} sans message quand tout est reserve.` : "."),
  });
}

export async function actionSurveillance(formData: FormData) {
  const session = await exigerSession();
  const lire = (nom: string) => formData.getAll(nom).map((v) => Number(v));
  const cantine = lire("cantine");
  const matin = lire("matin");
  const soir = lire("soir");
  await enregistrerSurveillance(session.parentId, { cantine, matin, soir });

  const periscolaire = matin.length + soir.length;
  retour({
    succes:
      (cantine.length === 0
        ? "Aucun jour de cantine surveille : vous ne serez plus prevenu d'un repas oublie"
        : `Cantine surveillee ${cantine.length} jour(s)`) +
      (periscolaire
        ? `, periscolaire ${periscolaire} creneau(x).`
        : ", periscolaire non surveille."),
  });
}

export async function actionPause() {
  const session = await exigerSession();
  const semaine = semaineAMettreEnPause(aujourdhuiParis());
  await mettreEnPause(session.parentId, semaine);
  retour({
    succes: `Rappels de cantine suspendus pour la semaine du ${semaine}. Le periscolaire continue.`,
  });
}

export async function actionReprendre() {
  const session = await exigerSession();
  await reprendreAlertes(session.parentId);
  retour({ succes: "Rappels de cantine reactives." });
}

export async function actionVerifier() {
  const session = await exigerSession();
  const r = await verifierMaintenant(session.parentId);
  if (!r.ok) retour({ erreur: r.message });

  const { apercu } = r;
  // Un etat non repertorie est compte comme non reserve, donc sans risque de
  // rappel manquant, mais il faut qu'il se voie ici aussi : c'est l'ecran ou le
  // parent regarde quand quelque chose lui semble anormal.
  const inconnus = apercu.inconnus.length
    ? ` (état${apercu.inconnus.length > 1 ? "s" : ""} non répertorié${
        apercu.inconnus.length > 1 ? "s" : ""
      } : ${apercu.inconnus.join(", ")})`
    : "";

  // Un jour ecarte par un reglage est invisible dans le resultat filtre : le
  // dire ici est ce qui rend un reglage trop restrictif detectable.
  const ecartes = apercu.ecartes.length
    ? ` ${apercu.ecartes.length} jour(s) ecarte(s) par vos reglages : ` +
      apercu.ecartes.map((m) => `${m.date} ${m.enfant}`).join(", ") + "."
    : "";
  const absentes = apercu.absentes.length
    ? ` ATTENTION : ${apercu.absentes.join(", ")} n'existe(nt) pas sur le portail, aucune ` +
      "alerte ne partira dessus."
    : "";
  const depassees = apercu.depassees.length
    ? ` ATTENTION : l'echeance est deja passee sur ${apercu.depassees.join(", ")} — ` +
      "signalez-le, la regle de delai est a revoir."
    : "";
  const periscolaire = apercu.periscolaire.length
    ? ` Periscolaire : ${apercu.periscolaire
        .map((m) => `${m.date} ${m.enfant} (${m.moment})`)
        .join(", ")}.`
    : "";
  const annexes = `${periscolaire}${ecartes}${absentes}${depassees}`;

  if (apercu.rienAVerifier) {
    retour({
      succes:
        `Semaine du ${apercu.semaine} : le portail ne propose aucun repas — vacances ` +
        `ou hors année scolaire. Rien à réserver.${inconnus}${annexes}`,
    });
  }
  retour({
    succes:
      (apercu.manquants.length === 0
        ? `Semaine du ${apercu.semaine} : ${apercu.reserves} réservation(s), rien à signaler.`
        : `Semaine du ${apercu.semaine} : ${apercu.manquants.length} repas non réservé(s) — ` +
          apercu.manquants.map((m) => `${m.date} ${m.enfant}`).join(", ")) +
      inconnus +
      annexes,
  });
}

export async function actionTesterMail(formData: FormData) {
  const session = await exigerSession();
  const date = String(formData.get("date") ?? "").trim();
  const destinataire = String(formData.get("destinataire") ?? "").trim().toLowerCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    retour({ erreur: "Choisissez une date valide." });
  }
  if (!destinataire) {
    retour({ erreur: "Choisissez l'adresse qui doit recevoir le message de test." });
  }

  // jourDepuisIso epingle la date a midi UTC, comme partout ailleurs : lire les
  // composantes locales ferait basculer d'un jour selon le fuseau du serveur,
  // qui tourne en UTC sur Vercel.
  const r = await envoyerMailTest(session.parentId, {
    date: jourDepuisIso(date),
    destinataire,
  });
  if (!r.ok) retour({ erreur: r.message });
  retour({
    succes: r.envoye
      ? `Message de test envoyé à ${r.destinataire}, objet « ${r.objet} ».`
      : r.raison,
  });
}

export async function actionDeconnexion() {
  await fermerSession();
  redirect("/connexion");
}
