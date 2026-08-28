import { createHmac } from "node:crypto";
import { egaliteConstante } from "../crypto.ts";
import { urlPublique } from "../url-publique.ts";

/**
 * Lien de desabonnement, signe plutot que stocke.
 *
 * Un parent qui veut arreter les rappels ne va pas demander un lien magique
 * pour ca : le lien doit fonctionner sans connexion. Une signature HMAC suffit,
 * sans ligne en base ni purge a prevoir, et le jeton ne donne acces qu'a une
 * seule action — il ne vaut pas une session.
 */

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET manquante. Generer : openssl rand -base64 32");
  return s;
}

const signature = (parentId: string) =>
  createHmac("sha256", secret()).update(`desabonnement:${parentId}`).digest("base64url");

export const signerDesabonnement = (parentId: string): string =>
  `${parentId}.${signature(parentId)}`;

export function verifierDesabonnement(jeton: string): string | null {
  const point = jeton.lastIndexOf(".");
  if (point < 1) return null;
  const parentId = jeton.slice(0, point);
  return egaliteConstante(jeton.slice(point + 1), signature(parentId)) ? parentId : null;
}

export const urlDesabonnement = (parentId: string): string =>
  `${urlPublique()}/desabonnement?jeton=${encodeURIComponent(signerDesabonnement(parentId))}`;
