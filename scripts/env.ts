import { readFileSync } from "node:fs";

/**
 * Charge le .env de la racine. Next le fait tout seul, pas les scripts lances
 * directement par node. Les variables deja presentes dans l'environnement
 * priment, pour pouvoir surcharger ponctuellement en ligne de commande.
 */
export function chargerEnv(): void {
  let texte: string;
  try {
    texte = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return;
  }
  for (const ligne of texte.split("\n")) {
    const t = ligne.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const cle = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q)) val = val.slice(1, -1);
    if (!(cle in process.env)) process.env[cle] = val;
  }
}
