import { verifierPause } from "../../lib/auth/pause.ts";
import { mettreEnPause, semaineAMettreEnPause } from "../../lib/service/reglages.ts";
import { ajouter, aujourdhuiParis, formaterJour, prochaineEcheance } from "../../lib/portail/dates.ts";

export const metadata = { title: "Pas de cantine cette semaine" };

/**
 * Page de confirmation, et non mise en pause directe au chargement du lien.
 *
 * Les antivirus et passerelles de securite suivent les liens des mails pour les
 * inspecter : une pause declenchee par un simple GET serait activee a l'insu du
 * parent, par un robot, et il ne recevrait plus ses rappels sans comprendre
 * pourquoi. Elle passe donc par un bouton, soit une action explicite. Meme
 * raisonnement que pour app/desabonnement.
 */
export default async function Pause({
  searchParams,
}: {
  searchParams: Promise<{ jeton?: string; fait?: string }>;
}) {
  const { jeton, fait } = await searchParams;
  const verifie = jeton ? verifierPause(jeton) : null;
  const aujourdhui = aujourdhuiParis();
  const semaineCourante = semaineAMettreEnPause(aujourdhui);
  // La pause se leve quand la semaine visee change, soit le lendemain de
  // l'echeance : un mardi.
  const reprise = formaterJour(ajouter(prochaineEcheance(aujourdhui), 1));

  async function couper(formData: FormData) {
    "use server";
    const { redirect } = await import("next/navigation");
    // Le jeton est reverifie ici : le formulaire est public, on ne se fie pas
    // a la verification faite au rendu de la page.
    const v = verifierPause(String(formData.get("jeton") ?? ""));
    if (v && v.semaine === semaineAMettreEnPause(aujourdhuiParis())) {
      await mettreEnPause(v.parentId, v.semaine);
      redirect("/pause?fait=1");
    }
    redirect("/pause");
  }

  if (fait) {
    return (
      <>
        <h1>C&apos;est note</h1>
        <div className="message succes">
          Vous ne recevrez plus de rappel de cantine jusqu&apos;au {reprise}.
        </div>
        <p>
          Les alertes de <strong>périscolaire</strong> continuent : elles se réservent la veille au
          soir, une pause a la semaine n&apos;aurait pas de sens pour elles.
        </p>
        <p className="doux">
          Vous avez changé d&apos;avis ? <a href="/reglages">Vos réglages</a> permettent de
          reprendre les rappels tout de suite.
        </p>
      </>
    );
  }

  if (!verifie) {
    return (
      <>
        <h1>Lien invalide</h1>
        <div className="message erreur">
          Ce lien est incorrect ou a ete tronque par votre logiciel de messagerie.
        </div>
        <p>
          Vous pouvez ajuster vos rappels depuis <a href="/reglages">vos réglages</a>.
        </p>
      </>
    );
  }

  // Un lien d'un mail plus ancien porte une semaine deja close : l'appliquer
  // ferait taire une semaine qui n'est plus en jeu, ou pire, laisserait croire
  // que la semaine en cours est couverte.
  if (verifie.semaine !== semaineCourante) {
    return (
      <>
        <h1>Ce lien a expiré</h1>
        <div className="message erreur">
          Il concerne la semaine du {formaterJour(new Date(`${verifie.semaine}T12:00:00Z`))}, dont
          l&apos;échéance est passée. Vos réglages n&apos;ont pas été modifiés.
        </div>
        <p>
          Le prochain rappel vous proposera de nouveau ce bouton, ou réglez vos jours depuis{" "}
          <a href="/reglages">vos réglages</a>.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Pas de cantine cette semaine</h1>
      <p>
        Nous cesserons de vous relancer au sujet de la cantine jusqu&apos;au {reprise}. Vos
        réglages, vos identifiants et vos destinataires sont conservés.
      </p>
      <p className="doux">
        Les alertes de <strong>périscolaire</strong> continueront : elles se réservent la veille
        avant minuit, et se jouent donc sur deux jours seulement.
      </p>
      <div className="carte">
        <form action={couper}>
          <input type="hidden" name="jeton" value={jeton} />
          <button type="submit">C&apos;est normal, ne me relancez plus</button>
        </form>
      </div>
    </>
  );
}
