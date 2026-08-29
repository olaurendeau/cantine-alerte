import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { egaliteConstante } from "../crypto.ts";
import { secretSignature } from "./secret.ts";

const COOKIE = "cantine_session";
const DUREE_JOURS = 30;

type Charge = { parentId: string; email: string; exp: number };

const signature = (corps: string) =>
  createHmac("sha256", secretSignature()).update(corps).digest("base64url");

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
