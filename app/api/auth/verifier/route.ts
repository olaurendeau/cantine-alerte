import { NextResponse } from "next/server";
import { urlPublique } from "../../../../lib/url-publique.ts";

/**
 * Ancienne adresse des liens de connexion, conservee pour les mails deja
 * partis. Elle ne consomme plus rien : elle redirige vers la page de
 * confirmation, qui explique pourquoi le jeton ne doit pas etre brule par un
 * simple GET (cf. app/connexion/verifier).
 */
export async function GET(requete: Request) {
  const token = new URL(requete.url).searchParams.get("token");
  // Toujours absolue : NextResponse.redirect refuse une URL relative, et une
  // APP_URL saisie sans schema produirait un echec au clic du parent.
  const base = urlPublique();

  if (!token) return NextResponse.redirect(`${base}/connexion?erreur=lien`);
  return NextResponse.redirect(
    `${base}/connexion/verifier?token=${encodeURIComponent(token)}`,
  );
}
