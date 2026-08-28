import { NextResponse } from "next/server";
import { consommerLien } from "../../../../lib/auth/liens.ts";
import { ouvrirSession } from "../../../../lib/auth/session.ts";

export async function GET(requete: Request) {
  const token = new URL(requete.url).searchParams.get("token");
  const base = process.env.APP_URL ?? new URL(requete.url).origin;

  if (!token) return NextResponse.redirect(`${base}/connexion?erreur=1`);

  const verifie = await consommerLien(token);
  if (!verifie) {
    // Jeton inconnu, expire ou deja utilise : on ne distingue pas les cas.
    return NextResponse.redirect(`${base}/connexion?erreur=1`);
  }

  await ouvrirSession(verifie.parentId, verifie.email);
  return NextResponse.redirect(`${base}/reglages`);
}
