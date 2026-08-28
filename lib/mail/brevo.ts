import type { Message } from "./index.ts";

const API = "https://api.brevo.com/v3/smtp/email";

/**
 * Envoi transactionnel via Brevo. Le plan gratuit couvre 300 mails par jour,
 * largement au-dessus du besoin (un rappel par foyer et par jour choisi).
 */
export async function envoyerBrevo(message: Message): Promise<void> {
  const cle = process.env.BREVO_API_KEY;
  const expediteur = process.env.MAIL_EXPEDITEUR;
  if (!cle) throw new Error("BREVO_API_KEY manquante (MAIL_PROVIDER=brevo)");
  if (!expediteur) throw new Error("MAIL_EXPEDITEUR manquante (MAIL_PROVIDER=brevo)");

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "api-key": cle,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: expediteur, name: process.env.MAIL_EXPEDITEUR_NOM ?? "Alerte cantine" },
      // Chaque parent recoit un message qui lui est adresse, sans voir les
      // autres adresses du foyer : Brevo separe les envois de `to`.
      to: message.destinataires.map((email) => ({ email })),
      subject: message.objet,
      textContent: message.corps,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Brevo HTTP ${res.status} : ${detail.slice(0, 300)}`);
  }
}
