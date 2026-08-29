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
  const echecs: { texte: string; passager: boolean }[] = [];
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
        echecs.push({
          texte: `${destinataire} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
          // Un 429 ou un 5xx passeront peut-etre au coup suivant ; un 4xx sur
          // une adresse refusee rendra la meme chose demain.
          passager: res.status === 429 || res.status >= 500,
        });
      }
    } catch (e) {
      // Delai depasse, DNS, connexion coupee : rien qui se reproduise forcement.
      echecs.push({ texte: `${destinataire} : ${(e as Error).message}`, passager: true });
    }
  }

  // On tente toutes les adresses avant d'echouer : une adresse invalide ne doit
  // pas priver le reste du foyer de son rappel.
  if (echecs.length === 0) return;
  const resume = echecs.map((e) => e.texte).join(" | ");

  if (echecs.length === message.destinataires.length) {
    throw new Error(`Brevo : aucun envoi n'a abouti. ${resume}`);
  }

  // Envoi partiel. Lever ou non decide du sort du verrou anti-doublon pose par
  // l'appelant : lever le libere, donc le rejeu de la soiree retentera ; se
  // taire le laisse en place, et l'adresse en echec perd definitivement son
  // rappel — le seul echec vraiment grave de ce service.
  //
  // On ne leve donc que si un nouvel essai a une chance d'aboutir. Une adresse
  // durablement refusee (faute de frappe dans les destinataires) ne doit pas,
  // elle, faire renvoyer le message a tout le foyer a chaque passage.
  if (echecs.some((e) => e.passager)) {
    throw new Error(`Brevo : envoi partiel rattrapable. ${resume}`);
  }
  console.error(`[mail] envois partiels definitifs, ${echecs.length} echec(s) : ${resume}`);
}
