import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { egaliteConstante } from "../crypto.ts";

const COOKIE = "cantine_session";
const DUREE_JOURS = 30;

type Charge = { parentId: string; email: string; exp: number };

/**
 * Cle de signature des cookies de session ET des jetons de desabonnement.
 *
 * La longueur est controlee comme celle de CANTINE_CLE_CHIFFREMENT : une valeur
 * courte passerait sans bruit et laisserait forger sessions et desabonnements.
 * Une variable mal renseignee doit echouer au demarrage, pas se deviner apres
 * coup.
 */
const LONGUEUR_MIN = 32;

function secret(): string {
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

const signature = (corps: string) =>
  createHmac("sha256", secret()).update(corps).digest("base64url");

/**
 * Session dans un cookie signe plutot qu'en base : il n'y a rien a revoquer
 * cote serveur, et une session ne donne acces qu'aux reglages du parent.
 */
export async function ouvrirSession(parentId: string, email: string): Promise<void> {
  const charge: Charge = {
    parentId,
    email,
    exp: Date.now() + DUREE_JOURS * 86_400_000,
  };
  const corps = Buffer.from(JSON.stringify(charge)).toString("base64url");
  const jar = await cookies();
  jar.set(COOKIE, `${corps}.${signature(corps)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DUREE_JOURS * 86_400,
  });
}

export async function fermerSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function sessionCourante(): Promise<Charge | null> {
  const brut = (await cookies()).get(COOKIE)?.value;
  if (!brut) return null;
  const point = brut.lastIndexOf(".");
  if (point < 1) return null;
  const corps = brut.slice(0, point);
  if (!egaliteConstante(brut.slice(point + 1), signature(corps))) return null;
  try {
    const charge = JSON.parse(Buffer.from(corps, "base64url").toString("utf8")) as Charge;
    return charge.exp > Date.now() ? charge : null;
  } catch {
    return null;
  }
}
