import { mkdirSync, writeFileSync } from "node:fs";
import type { Message } from "./index.ts";

/**
 * Ecrit le mail sur la console au lieu de l'envoyer. C'est le mode par defaut :
 * en developpement on veut relire le contenu, pas remplir une boite mail, et le
 * depot doit fonctionner sans compte chez un fournisseur.
 *
 * La version HTML est deposee dans apercu/ pour pouvoir etre ouverte dans un
 * navigateur : afficher son source dans un terminal ne servirait a personne.
 */
export async function envoyerConsole(message: Message): Promise<void> {
  const barre = "=".repeat(64);
  const lignes = [
    barre,
    `A      : ${message.destinataires.join(", ")}`,
    `Objet  : ${message.objet}`,
    "-".repeat(64),
    message.corps,
  ];

  if (message.html) {
    const chemin = deposerHtml(message);
    if (chemin) lignes.push("-".repeat(64), `HTML   : ${chemin}`);
  }
  lignes.push(barre);
  console.log(lignes.join("\n"));
}

/** Retourne le chemin ecrit, ou null si le depot n'est pas possible (lecture seule). */
function deposerHtml(message: Message): string | null {
  try {
    const dossier = new URL("../../apercu/", import.meta.url);
    mkdirSync(dossier, { recursive: true });
    const nom = `envoi-${horodatage()}-${assainir(message.objet)}.html`;
    const cible = new URL(nom, dossier);
    writeFileSync(cible, message.html!);
    return cible.pathname;
  } catch {
    // Un systeme de fichiers en lecture seule ne doit pas faire echouer un
    // envoi : l'essentiel, le texte, est deja sur la console.
    return null;
  }
}

const horodatage = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const assainir = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)
    .toLowerCase();
