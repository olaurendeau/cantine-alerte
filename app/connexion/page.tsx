import { envoyerLienMagique } from "../../lib/auth/liens.ts";
import { urlDepot } from "../../lib/url-publique.ts";

export default async function Connexion({
  searchParams,
}: {
  searchParams: Promise<{ envoye?: string; erreur?: string }>;
}) {
  const { envoye, erreur } = await searchParams;

  async function demander(formData: FormData) {
    "use server";
    const { redirect } = await import("next/navigation");
    const email = String(formData.get("email") ?? "").trim();
    if (!email.includes("@")) redirect("/connexion?erreur=1");
    await envoyerLienMagique(email);
    redirect("/connexion?envoye=1");
  }

  return (
    <>
      <h1>Alerte cantine</h1>
      <p className="doux">
        Un rappel par mail quand des repas ne sont pas reserves, avant que l&apos;echeance du
        portail ne passe.
      </p>

      {envoye && (
        <div className="message succes">
          Si cette adresse est valide, un lien de connexion vient d&apos;etre envoye. Il expire dans
          20 minutes.
        </div>
      )}
      {erreur && <div className="message erreur">Adresse email invalide.</div>}

      <form action={demander} className="carte">
        <label htmlFor="email">Votre adresse email</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
        <button type="submit">Recevoir un lien de connexion</button>
        <p className="doux" style={{ marginTop: "1rem", marginBottom: 0 }}>
          Pas de mot de passe a retenir : chaque connexion se fait par un lien a usage unique.
        </p>
      </form>

      <p className="doux">
        <a href="/confidentialite">Ce que nous stockons, et pourquoi</a>
        {" · "}
        <a href={urlDepot()} target="_blank" rel="noreferrer noopener">
          Code source
        </a>
      </p>
    </>
  );
}
