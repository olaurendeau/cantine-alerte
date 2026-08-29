import { consommerLien } from "../../../lib/auth/liens.ts";
import { ouvrirSession } from "../../../lib/auth/session.ts";

export const metadata = { title: "Connexion" };

/**
 * Page de confirmation, et non connexion au chargement du lien.
 *
 * Les antivirus et passerelles de securite des messageries (Outlook Safe Links,
 * Proofpoint) suivent les liens des mails pour les inspecter. Un jeton a usage
 * unique consomme par un simple GET serait donc brule par un robot avant meme
 * que le parent ne clique, et celui-ci lirait "lien invalide" sans comprendre.
 * Le rendu ne consomme rien ; c'est le bouton, donc un POST, qui ouvre la
 * session. Meme raisonnement que pour app/desabonnement.
 */
export default async function Verifier({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  async function connecter(formData: FormData) {
    "use server";
    const { redirect } = await import("next/navigation");
    const verifie = await consommerLien(String(formData.get("token") ?? ""));
    // Jeton inconnu, expire ou deja utilise : les trois cas se valent pour le
    // parent, et les distinguer renseignerait un attaquant. Le motif est en
    // revanche distingue de "adresse invalide", sans quoi le parent lirait un
    // message sans rapport avec ce qu'il vient de faire.
    if (!verifie) return redirect("/connexion?erreur=lien");
    await ouvrirSession(verifie.parentId, verifie.email);
    redirect("/reglages");
  }

  if (!token) {
    return (
      <>
        <h1>Lien invalide</h1>
        <div className="message erreur">
          Ce lien de connexion est incomplet ou a ete tronque par votre logiciel de messagerie.
        </div>
        <p>
          <a href="/connexion">Demandez-en un nouveau</a>, il arrive en quelques secondes.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Connexion a Alerte cantine</h1>
      <p>Il ne reste qu&apos;a confirmer que c&apos;est bien vous qui ouvrez ce lien.</p>
      <div className="carte">
        <form action={connecter}>
          <input type="hidden" name="token" value={token} />
          <button type="submit">Me connecter</button>
        </form>
      </div>
      <p className="doux">
        Ce lien est valable une seule fois. S&apos;il a expire,{" "}
        <a href="/connexion">demandez-en un nouveau</a>.
      </p>
    </>
  );
}
