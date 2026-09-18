import { createHmac } from "node:crypto";
import { egaliteConstante } from "../crypto.ts";
import { urlPublique } from "../url-publique.ts";
import { secretSignature } from "./secret.ts";

/**
 * Lien de mise en pause de la cantine, signe plutot que stocke.
 *
 * Meme raisonnement que pour le desabonnement : le lien part dans un mail et
 * doit fonctionner sans connexion, une signature HMAC suffit, sans ligne en
 * base ni purge a prevoir.
 *
 * Deux differences essentielles :
 *
 * 1. Le prefixe du message signe est "pause", pas "desabonnement". Sans lui,
 *    un jeton de desabonnement vaudrait pour la pause et reciproquement.
 * 2. La SEMAINE VISEE fait partie de la charge signee. Le jeton ne peut donc
 *    pas servir a mettre en pause une autre semaine que celle dont parlait le
 *    mail : un lien de la semaine derniere est rejete au lieu de faire taire
 *    la semaine en cours.
 */

const signature = (parentId: string, semaine: string) =>
  createHmac("sha256", secretSignature())
    .update(`pause:${parentId}:${semaine}`)
    .digest("base64url");

export const signerPause = (parentId: string, semaine: string): string =>
  `${parentId}.${semaine}.${signature(parentId, semaine)}`;

export function verifierPause(jeton: string): { parentId: string; semaine: string } | null {
  const parts = jeton.split(".");
  if (parts.length !== 3) return null;
  const [parentId, semaine, sig] = parts;
  if (!parentId || !semaine) return null;
  return egaliteConstante(sig, signature(parentId, semaine)) ? { parentId, semaine } : null;
}

export const urlPause = (parentId: string, semaine: string): string =>
  `${urlPublique()}/pause?jeton=${encodeURIComponent(signerPause(parentId, semaine))}`;
