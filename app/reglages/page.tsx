import { redirect } from "next/navigation";
import { sessionCourante } from "../../lib/auth/session.ts";
import { JOURS_AVANT_POSSIBLES, libelleJourAvant } from "../../lib/portail/dates.ts";
import { chargerReglages } from "../../lib/service/reglages.ts";
import { estAdmin } from "../../lib/service/verification.ts";
import {
  actionDeconnexion,
  actionDestinataires,
  actionIdentifiants,
  actionRappels,
  actionVerifier,
} from "./actions.ts";

export default async function Reglages({
  searchParams,
}: {
  searchParams: Promise<{ succes?: string; erreur?: string }>;
}) {
  const session = await sessionCourante();
  if (!session) redirect("/connexion");

  const reglages = await chargerReglages(session.parentId);
  if (!reglages) redirect("/connexion");

  const { succes, erreur } = await searchParams;

  return (
    <>
      <h1>Reglages</h1>
      <p className="doux">
        Connecte en tant que {reglages.email}.{" "}
        {estAdmin(reglages.email) && <a href="/admin">Administration</a>}
      </p>

      {succes && <div className="message succes">{succes}</div>}
      {erreur && <div className="message erreur">{erreur}</div>}

      {!reglages.actif && (
        <div className="message erreur">
          Les rappels sont suspendus : le portail a refuse les identifiants enregistres a plusieurs
          reprises. Enregistrez-en de nouveaux pour reactiver la surveillance.
        </div>
      )}

      <section className="carte">
        <h2>Identifiants du portail</h2>
        <p className="doux">
          Necessaires pour consulter vos reservations a votre place. Le mot de passe est chiffre et
          n&apos;est jamais reaffiche : pour le changer, saisissez-en un nouveau.{" "}
          <a href="/confidentialite">En savoir plus</a>
        </p>
        <form action={actionIdentifiants}>
          <label htmlFor="portailEmail">Identifiant portail</label>
          <input
            id="portailEmail"
            name="portailEmail"
            type="email"
            defaultValue={reglages.portailEmail ?? ""}
            required
          />
          <label htmlFor="motDePasse">Mot de passe du portail</label>
          <input
            id="motDePasse"
            name="motDePasse"
            type="password"
            autoComplete="off"
            placeholder={reglages.motDePasseEnregistre ? "•••••••• (enregistre)" : ""}
            required
          />
          <button type="submit">Verifier et enregistrer</button>
        </form>

        <p className="doux" style={{ marginTop: "1rem", marginBottom: 0 }}>
          {reglages.verifieLe
            ? `Derniere verification reussie le ${reglages.verifieLe.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}.`
            : "Aucune verification reussie pour l'instant."}
          {reglages.derniereErreur && ` Derniere erreur : ${reglages.derniereErreur}`}
        </p>
      </section>

      <section className="carte">
        <h2>Destinataires des rappels</h2>
        <p className="doux">
          Une adresse par ligne. Souvent les deux parents du foyer. Ces adresses sont independantes
          de celle utilisee pour vous connecter.
        </p>
        <form action={actionDestinataires}>
          <label htmlFor="destinataires">Adresses</label>
          <textarea
            id="destinataires"
            name="destinataires"
            rows={3}
            defaultValue={reglages.destinataires.join("\n")}
            style={{
              width: "100%",
              padding: "0.55rem 0.7rem",
              borderRadius: 7,
              font: "inherit",
              marginBottom: "1rem",
            }}
          />
          <button type="submit">Enregistrer les destinataires</button>
        </form>
      </section>

      <section className="carte">
        <h2>Quand vous rappeler</h2>
        <p className="doux">
          Les reservations ferment le lundi a minuit pour la semaine suivante. Choisissez les jours
          ou vous voulez etre prevenu s&apos;il manque des repas.
        </p>
        <p className="doux">
          Par defaut vous recevez aussi un mot les jours ou <strong>tout est deja reserve</strong> :
          sans cela, une boite vide ne vous dit pas si tout va bien ou si le service est en panne.
          Decochez la seconde case pour n&apos;etre prevenu qu&apos;en cas de probleme.
        </p>
        <form action={actionRappels}>
          <div className="tableau">
            <table>
              <thead>
                <tr>
                  <th>Jour</th>
                  <th>Me prevenir</th>
                  <th>Meme si tout est reserve</th>
                </tr>
              </thead>
              <tbody>
                {JOURS_AVANT_POSSIBLES.map((n) => (
                  <tr key={n}>
                    <td>{libelleJourAvant(n)}</td>
                    <td>
                      <input
                        type="checkbox"
                        name="jours"
                        value={n}
                        aria-label={`Me prevenir ${libelleJourAvant(n)}`}
                        defaultChecked={reglages.joursAvant.includes(n)}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        name="confirmation"
                        value={n}
                        aria-label={`Confirmer ${libelleJourAvant(n)} meme si tout est reserve`}
                        // Coche par defaut, y compris pour un jour pas encore
                        // choisi : activer le rappel active la confirmation.
                        defaultChecked={!reglages.joursSilencieux.includes(n)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="doux">
            La seconde colonne n&apos;a d&apos;effet que si la premiere est cochee.
          </p>
          <button type="submit">Enregistrer les rappels</button>
        </form>
      </section>

      <section className="carte">
        <h2>Verifier maintenant</h2>
        <p className="doux">
          Interroge le portail immediatement et affiche l&apos;etat de la semaine visee, sans
          envoyer de mail.
        </p>
        <form action={actionVerifier}>
          <button type="submit" className="secondaire">
            Verifier maintenant
          </button>
        </form>
      </section>

      <form action={actionDeconnexion}>
        <button type="submit" className="secondaire">
          Se deconnecter
        </button>
      </form>
    </>
  );
}
