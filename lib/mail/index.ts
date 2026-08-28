import { envoyerConsole } from "./console.ts";
import { envoyerBrevo } from "./brevo.ts";

export type Message = {
  /** Un compte porte souvent deux adresses : les deux parents du foyer. */
  destinataires: string[];
  objet: string;
  corps: string;
};

export type Expediteur = (message: Message) => Promise<void>;

/**
 * `console` est le defaut : le depot est clonable et testable de bout en bout
 * sans creer de compte Brevo. `brevo` n'est requis qu'en production.
 */
export function expediteur(): Expediteur {
  const choix = process.env.MAIL_PROVIDER ?? "console";
  if (choix === "console") return envoyerConsole;
  if (choix === "brevo") return envoyerBrevo;
  throw new Error(`MAIL_PROVIDER inconnu : ${choix} (attendu "console" ou "brevo")`);
}

/** Envoie sans laisser une adresse invalide faire echouer les autres. */
export async function envoyerA(
  expedier: Expediteur,
  destinataires: string[],
  objet: string,
  corps: string,
): Promise<void> {
  if (destinataires.length === 0) return;
  await expedier({ destinataires, objet, corps });
}
