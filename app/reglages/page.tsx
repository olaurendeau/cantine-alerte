import { redirect } from "next/navigation";
import { sessionCourante } from "../../lib/auth/session.ts";
import { JOURS_AVANT_POSSIBLES, aujourdhuiParis, iso } from "../../lib/portail/dates.ts";
import { chargerReglages } from "../../lib/service/reglages.ts";
import { estAdmin } from "../../lib/service/verification.ts";
import {
  actionDeconnexion,
  actionDestinataires,
  actionIdentifiants,
  actionRappels,
  actionTesterMail,
  actionVerifier,
} from "./actions.ts";
import { LignesRappel } from "./lignes-rappel.tsx";

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

  // Les memes adresses que celles d'un vrai rappel, a defaut celle du compte :
  // un test n'a d'interet que s'il emprunte le chemin reel.
  const adressesTest = reglages.destinataires.length
    ? reglages.destinataires
    : [reglages.email];

  return (
    <>
      <h1>Réglages</h1>
      <p className="doux">
        Connecté en tant que {reglages.email}.{" "}
        {estAdmin(reglages.email) && <a href="/admin">Administration</a>}
      </p>

      {succes && <div className="message succes">{succes}</div>}
      {erreur && <div className="message erreur">{erreur}</div>}

      {!reglages.actif && (
        <div className="message erreur">
          Les rappels sont suspendus : le portail a refusé les identifiants enregistrés à
          plusieurs reprises. Enregistrez-en de nouveaux pour réactiver la surveillance.
        </div>
      )}

      <section className="carte">
        <h2>Identifiants du portail</h2>
        <p className="doux">
          Nécessaires pour consulter vos réservations à votre place. Le mot de passe est chiffré
          et n&apos;est jamais réaffiché : pour le changer, saisissez-en un nouveau.{" "}
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
            placeholder={reglages.motDePasseEnregistre ? "•••••••• (enregistré)" : ""}
            required
          />
          <button type="submit">Vérifier et enregistrer</button>
        </form>

        <p className="doux" style={{ marginTop: "1rem", marginBottom: 0 }}>
          {reglages.verifieLe
            ? `Dernière vérification réussie le ${reglages.verifieLe.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}.`
            : "Aucune vérification réussie pour l'instant."}
          {reglages.derniereErreur && ` Dernière erreur : ${reglages.derniereErreur}`}
        </p>
      </section>

      <section className="carte">
        <h2>Destinataires des rappels</h2>
        <p className="doux">
          Une adresse par ligne. Souvent les deux parents du foyer. Ces adresses sont
          indépendantes de celle utilisée pour vous connecter.
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
          Les réservations ferment le lundi à minuit pour la semaine suivante. Choisissez les
          jours où vous voulez être prévenu s&apos;il manque des repas.
        </p>
        <p className="doux">
          Par défaut vous recevez aussi un mot les jours où <strong>tout est déjà réservé</strong> :
          sans cela, une boîte vide ne vous dit pas si tout va bien ou si le service est en panne.
          Décochez la seconde case pour n&apos;être prévenu qu&apos;en cas de problème.
        </p>
        <form action={actionRappels}>
          <div className="tableau">
            <table>
              <thead>
                <tr>
                  <th>Jour</th>
                  <th>Me prévenir</th>
                  <th>Même si tout est réservé</th>
                </tr>
              </thead>
              <tbody>
                <LignesRappel
                  joursPossibles={JOURS_AVANT_POSSIBLES}
                  joursAvant={reglages.joursAvant}
                  joursSilencieux={reglages.joursSilencieux}
                />
              </tbody>
            </table>
          </div>
          <button type="submit">Enregistrer les rappels</button>
        </form>
      </section>

      <section className="carte">
        <h2>Vérifier maintenant</h2>
        <p className="doux">
          Interroge le portail immédiatement et affiche l&apos;état de la semaine visée, sans
          envoyer de mail.
        </p>
        <form action={actionVerifier}>
          <button type="submit" className="secondaire">
            Vérifier maintenant
          </button>
        </form>
      </section>

      <section className="carte">
        <h2>Tester l&apos;envoi</h2>
        <p className="doux">
          Envoie à une seule adresse le message qui partirait à la date choisie, avec{" "}
          <strong>[Test]</strong> dans l&apos;objet. La date sert d&apos;« aujourd&apos;hui » : elle
          détermine l&apos;échéance, la semaine examinée et le passage en message urgent, ce qui
          permet de voir le rappel de la veille sans attendre dimanche soir.
        </p>
        <p className="doux">
          Rien n&apos;est enregistré : le vrai rappel du jour reste dû. Attention, choisir une date
          change la semaine <em>examinée</em>, pas l&apos;état du portail, qui reste celui
          d&apos;aujourd&apos;hui — une date passée ne rejoue pas l&apos;historique.
        </p>
        <form action={actionTesterMail}>
          <label htmlFor="dateTest">Se positionner au</label>
          <input
            id="dateTest"
            name="date"
            type="date"
            defaultValue={iso(aujourdhuiParis())}
            required
          />
          <label htmlFor="destinataireTest">Envoyer à</label>
          <select id="destinataireTest" name="destinataire" required>
            {adressesTest.map((adresse) => (
              <option key={adresse} value={adresse}>
                {adresse}
              </option>
            ))}
          </select>
          <button type="submit" className="secondaire">
            Envoyer un mail de test
          </button>
        </form>
      </section>

      <form action={actionDeconnexion}>
        <button type="submit" className="secondaire">
          Se déconnecter
        </button>
      </form>
    </>
  );
}
