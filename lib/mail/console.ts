import type { Message } from "./index.ts";

/**
 * Ecrit le mail sur la console au lieu de l'envoyer. C'est le mode par defaut :
 * en developpement on veut relire le contenu, pas remplir une boite mail, et le
 * depot doit fonctionner sans compte chez un fournisseur.
 */
export async function envoyerConsole(message: Message): Promise<void> {
  const barre = "=".repeat(64);
  console.log(
    [
      barre,
      `A      : ${message.destinataires.join(", ")}`,
      `Objet  : ${message.objet}`,
      "-".repeat(64),
      message.corps,
      barre,
    ].join("\n"),
  );
}
