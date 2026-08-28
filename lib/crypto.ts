import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Chiffrement des mots de passe portail.
 *
 * Contrainte structurelle : le cron doit rejouer le mot de passe du parent en
 * son absence, donc le chiffrement est reversible et le service peut dechiffrer.
 * Ce que ce module apporte malgre tout : la cle n'est pas en base, donc un dump
 * Postgres (sauvegarde, chaine de connexion fuitee, injection SQL) ne donne que
 * du chiffre inerte. C'est la classe de risque la plus probable.
 *
 * Module volontairement court et sans dependance : assez isole pour etre
 * remplace par un KMS plus tard sans toucher au reste du code.
 */

export const VERSION_CLE_COURANTE = 1;

const ALGO = "aes-256-gcm";
const TAILLE_IV = 12; // 96 bits, recommande pour GCM
const TAILLE_CLE = 32;

function cle(): Buffer {
  const brut = process.env.CANTINE_CLE_CHIFFREMENT;
  if (!brut) {
    throw new Error(
      "CANTINE_CLE_CHIFFREMENT manquante. Generer une cle : openssl rand -base64 32",
    );
  }
  const k = Buffer.from(brut, "base64");
  if (k.length !== TAILLE_CLE) {
    throw new Error(
      `CANTINE_CLE_CHIFFREMENT doit faire 32 octets une fois decodee en base64 ` +
        `(actuellement ${k.length}). Generer : openssl rand -base64 32`,
    );
  }
  return k;
}

/**
 * L'identifiant du parent sert de donnee associee authentifiee : un chiffre
 * copie sur la ligne d'un autre parent echouera au dechiffrement au lieu de
 * lui donner acces au portail du premier.
 */
const aad = (parentId: string) => Buffer.from(parentId, "utf8");

/** Retourne "<iv base64>:<tag base64>:<chiffre base64>". */
export function chiffrer(clair: string, parentId: string): string {
  const iv = randomBytes(TAILLE_IV);
  const c = createCipheriv(ALGO, cle(), iv);
  c.setAAD(aad(parentId));
  const chiffre = Buffer.concat([c.update(clair, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), chiffre].map((b) => b.toString("base64")).join(":");
}

export function dechiffrer(charge: string, parentId: string): string {
  const parties = charge.split(":");
  if (parties.length !== 3) {
    throw new Error("Format de chiffre invalide, attendu iv:tag:chiffre");
  }
  const [iv, tag, chiffre] = parties.map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv(ALGO, cle(), iv);
  d.setAAD(aad(parentId));
  d.setAuthTag(tag);
  // GCM leve ici si le tag ne correspond pas : cle differente, chiffre altere,
  // ou chiffre appartenant a un autre parent.
  return Buffer.concat([d.update(chiffre), d.final()]).toString("utf8");
}

/** Comparaison a temps constant, pour CRON_SECRET et les tokens de session. */
export function egaliteConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
