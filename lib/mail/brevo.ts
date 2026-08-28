import type { Message } from "./index.ts";

const API = "https://api.brevo.com/v3/smtp/email";

/**
 * fetch n'a pas de delai par defaut, et le cron envoie un mail par destinataire
 * en sequence dans une fonction plafonnee a 300 s. Sans borne, une seule
 * connexion qui pend priverait de rappel toutes les familles suivantes.
 */
const DELAI_MAX_MS = 10_000;

/**
 * Envoi transactionnel via Brevo. Le plan gratuit couvre 300 mails par jour,
 * largement au-dessus du besoin (un rappel par foyer et par jour choisi).
 */
export async function envoyerBrevo(message: Message): Promise<void> {
  const cle = process.env.BREVO_API_KEY;
  const expediteur = process.env.MAIL_EXPEDITEUR;
  if (!cle) throw new Error("BREVO_API_KEY manquante (MAIL_PROVIDER=brevo)");
  if (!expediteur) throw new Error("MAIL_EXPEDITEUR manquante (MAIL_PROVIDER=brevo)");

  const sender = {
    email: expediteur,
    name: process.env.MAIL_EXPEDITEUR_NOM ?? "Alerte cantine",
  };

  // Un appel par destinataire : passer plusieurs adresses dans `to` produit un
  // seul message ou elles se voient mutuellement. Un foyer peut ajouter un
  // grand-parent ou une nounou, qui n'ont pas a decouvrir les adresses des
  // autres. Le cout tient largement dans le quota gratuit (300 mails/jour).
  const echecs: string[] = [];
  for (const destinataire of message.destinataires) {
    try {
      const res = await fetch(API, {
        signal: AbortSignal.timeout(DELAI_MAX_MS),
        method: "POST",
        headers: {
          "api-key": cle,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          sender,
          to: [{ email: destinataire }],
          subject: message.objet,
          // Les deux versions systematiquement : le client choisit, et un
          // message sans partie texte est plus souvent classe en indesirable.
          textContent: message.corps,
          ...(message.html ? { htmlContent: message.html } : {}),
        }),
      });
      if (!res.ok) {
        echecs.push(`${destinataire} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    } catch (e) {
      echecs.push(`${destinataire} : ${(e as Error).message}`);
    }
  }

  // On tente toutes les adresses avant d'echouer : une adresse invalide ne doit
  // pas priver le reste du foyer de son rappel.
  if (echecs.length === message.destinataires.length) {
    throw new Error(`Brevo : aucun envoi n'a abouti. ${echecs.join(" | ")}`);
  }
  if (echecs.length) {
    console.error(`[mail] envois partiels, ${echecs.length} echec(s) : ${echecs.join(" | ")}`);
  }
}
