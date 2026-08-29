/**
 * Cle de signature partagee par les cookies de session et les jetons de
 * desabonnement.
 *
 * La longueur est controlee comme celle de CANTINE_CLE_CHIFFREMENT : une valeur
 * courte passerait sans bruit et laisserait forger sessions et desabonnements.
 *
 * Un seul exemplaire de ce controle : les deux usages doivent exiger la meme
 * chose, et deux copies de la meme regle finiraient par diverger le jour ou on
 * releve le minimum ou ou l'on compte les octets plutot que les caracteres.
 */
const LONGUEUR_MIN = 32;

export function secretSignature(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET manquante. Generer : openssl rand -base64 32");
  if (s.length < LONGUEUR_MIN) {
    throw new Error(
      `SESSION_SECRET trop courte (${s.length} caracteres, minimum ${LONGUEUR_MIN}). ` +
        "Generer : openssl rand -base64 32",
    );
  }
  return s;
}
