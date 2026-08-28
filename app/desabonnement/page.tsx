import { eq } from "drizzle-orm";
import { verifierDesabonnement } from "../../lib/auth/desabonnement.ts";
import { db } from "../../lib/db/index.ts";
import { rappels } from "../../lib/db/schema.ts";

export const metadata = { title: "Ne plus recevoir de rappels" };

/**
 * Page de confirmation, et non desabonnement direct au chargement du lien.
 *
 * Les antivirus et passerelles de securite suivent les liens des mails pour les
 * inspecter : un desabonnement declenche par un simple GET serait active a
 * l'insu du parent, par un robot. La coupure passe donc par un bouton, soit une
 * action explicite.
 */
export default async function Desabonnement({
  searchParams,
}: {
  searchParams: Promise<{ jeton?: string; fait?: string }>;
}) {
  const { jeton, fait } = await searchParams;
  const parentId = jeton ? verifierDesabonnement(jeton) : null;

  async function couper(formData: FormData) {
    "use server";
    const { redirect } = await import("next/navigation");
    // Le jeton est reverifie ici : le formulaire est public, on ne se fie pas
    // a la verification faite au rendu de la page.
    const id = verifierDesabonnement(String(formData.get("jeton") ?? ""));
    if (id) {
      await db.update(rappels).set({ joursAvant: [] }).where(eq(rappels.parentId, id));
      redirect("/desabonnement?fait=1");
    }
    redirect("/desabonnement");
  }

  if (fait) {
    return (
      <>
        <h1>Rappels desactives</h1>
        <div className="message succes">
          Vous ne recevrez plus de rappels. Votre compte et vos identifiants sont conserves.
        </div>
        <p>
          Pour les reactiver, rendez-vous dans <a href="/reglages">vos reglages</a> et choisissez a
          nouveau vos jours.
        </p>
      </>
    );
  }

  if (!parentId) {
    return (
      <>
        <h1>Lien invalide</h1>
        <div className="message erreur">
          Ce lien de desabonnement est incorrect ou a ete tronque par votre logiciel de messagerie.
        </div>
        <p>
          Vous pouvez desactiver vos rappels depuis <a href="/reglages">vos reglages</a>.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Ne plus recevoir de rappels</h1>
      <p>
        Vos rappels de cantine seront desactives. Votre compte, vos identifiants et vos
        destinataires sont conserves : vous pourrez les reactiver a tout moment.
      </p>
      <div className="carte">
        <form action={couper}>
          <input type="hidden" name="jeton" value={jeton} />
          <button type="submit">Desactiver mes rappels</button>
        </form>
      </div>
      <p className="doux">
        Vous cherchiez plutot a en ajuster la frequence ? <a href="/reglages">Vos reglages</a>{" "}
        permettent de choisir les jours un par un.
      </p>
    </>
  );
}
