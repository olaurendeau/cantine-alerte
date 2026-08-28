import { NextResponse } from "next/server";
import { consommerLien } from "../../../../lib/auth/liens.ts";
import { ouvrirSession } from "../../../../lib/auth/session.ts";
import { urlPublique } from "../../../../lib/url-publique.ts";

export async function GET(requete: Request) {
  const token = new URL(requete.url).searchParams.get("token");
  // Toujours absolue : NextResponse.redirect refuse une URL relative, et une
  // APP_URL saisie sans schema produirait un echec au clic du parent.
  const base = urlPublique();

  if (!token) return NextResponse.redirect(`${base}/connexion?erreur=1`);

  const verifie = await consommerLien(token);
  if (!verifie) {
    // Jeton inconnu, expire ou deja utilise : on ne distingue pas les cas.
    return NextResponse.redirect(`${base}/connexion?erreur=1`);
  }

  await ouvrirSession(verifie.parentId, verifie.email);
  return NextResponse.redirect(`${base}/reglages`);
}
