import { redirect } from "next/navigation";
import { sessionCourante } from "../../lib/auth/session.ts";
import {
  JOURS_AVANT_POSSIBLES,
  JOURS_SEMAINE_UI,
  aujourdhuiParis,
  formaterJour,
  iso,
  jourDepuisIso,
  prochaineEcheance,
} from "../../lib/portail/dates.ts";
import { chargerReglages, semaineAMettreEnPause } from "../../lib/service/reglages.ts";
import { estAdmin } from "../../lib/service/verification.ts";
import {
  actionDeconnexion,
  actionDestinataires,
  actionIdentifiants,
  actionPause,
  actionRappels,
  actionReprendre,
  actionSurveillance,
  actionTesterMail,
  actionVerifier,
} from "./actions.ts";
import { GrilleSurveillance } from "./grille-surveillance.tsx";
import { LignesRappel } from "./lignes-rappel.tsx";
import {
  etatGlobal,
  resumeDestinataires,
  resumeIdentifiants,
  resumeRappels,
  resumeSurveillance,
} from "./resume.ts";
import { Section } from "./section.tsx";

export default async function Reglages({
  searchParams,
}: {
  searchParams: Promise<{ succes?: string; erreur?: string; ouvrir?: string }>;
}) {
  const session = await sessionCourante();
  if (!session) redirect("/connexion");

  const reglages = await chargerReglages(session.parentId);
  if (!reglages) redirect("/connexion");

  const { succes, erreur, ouvrir } = await searchParams;

  // Les memes adresses que celles d'un vrai rappel, a defaut celle du compte :
  // un test n'a d'interet que s'il emprunte le chemin reel.
  const adressesTest = reglages.destinataires.length
    ? reglages.destinataires
    : [reglages.email];

  // La semaine que le bouton de pause ferait taire, et celle deja mise en
  // silence le cas echeant : les comparer dit si la pause court encore.
  const aujourdhui = aujourdhuiParis();
  const semaineCourante = semaineAMettreEnPause(aujourdhui);
  const enPause = reglages.pauseSemaine === semaineCourante;

  // Les resumes sont calcules avant le rendu : ils decident a la fois du
  // libelle de chaque section fermee, de celles qui s'ouvrent d'office, et de
  // la ligne d'etat en tete de page. Un seul verdict, trois usages — sinon
  // l'en-tete finirait par annoncer « tout va bien » au-dessus d'une section
  // en rouge.
  const identifiants = resumeIdentifiants(reglages);
  const destinataires = resumeDestinataires(reglages.destinataires);
  const surveillance = resumeSurveillance({
    cantine: reglages.joursCantine,
    matin: reglages.joursMatin,
    soir: reglages.joursSoir,
  });
  const rappels = resumeRappels({
    joursAvant: reglages.joursAvant,
    joursSilencieux: reglages.joursSilencieux,
    avecCantine: reglages.joursCantine.length > 0,
  });

  const global = etatGlobal(
    [
      identifiants.ton === "attention" && "vos identifiants du portail",
      destinataires.ton === "attention" && "les destinataires des rappels",
      surveillance.ton === "attention" && "les jours à surveiller",
      rappels.ton === "attention" && "les jours de rappel",
    ].filter((m): m is string => Boolean(m)),
  );

  // Une section reste ouverte quand elle vient d'etre utilisee et que quelque
  // chose cloche : replier sur une erreur cacherait le champ a corriger.
  const ouverte = (nom: string, resume?: { ton: string }) =>
    ouvrir === nom || resume?.ton === "attention";

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

      <div className={`bilan ${global.ton}`}>
        <strong>
          <span aria-hidden="true">{global.ton === "ok" ? "✓ " : "⚠ "}</span>
          {global.texte}
        </strong>
        {global.ton === "ok" && reglages.joursCantine.length > 0 && (
          <>
            {" "}
            Prochaine échéance cantine : {formaterJour(prochaineEcheance(aujourdhui))} à minuit.
          </>
        )}
      </div>

      <Section
        titre="Identifiants du portail"
        resume={identifiants}
        ouvert={ouverte("identifiants", identifiants)}
      >
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
      </Section>

      <Section
        titre="Destinataires des rappels"
        resume={destinataires}
        ouvert={ouverte("destinataires", destinataires)}
      >
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
          />
          <button type="submit">Enregistrer les destinataires</button>
        </form>
      </Section>

      <Section
        titre="Ce que l'on surveille"
        resume={surveillance}
        ouvert={ouverte("surveillance", surveillance)}
      >
        <p className="doux">
          Cochez les jours où vos enfants doivent être inscrits.{" "}
          <strong>Cantine</strong> : tout est coché par défaut — décochez les jours où ils ne
          mangent jamais à la cantine, vous ne serez plus relancé pour ces jours-là.
        </p>
        <p className="doux">
          <strong>Périscolaire du matin et du soir</strong> : rien n&apos;est coché par défaut. Ces
          inscriptions se réservent <strong>jusqu&apos;à la veille à minuit</strong> ; si vous
          cochez un jour, vous serez prévenu l&apos;avant-veille puis la veille en cas d&apos;oubli.
        </p>
        <form action={actionSurveillance}>
          <GrilleSurveillance
            joursPossibles={JOURS_SEMAINE_UI}
            cantine={reglages.joursCantine}
            matin={reglages.joursMatin}
            soir={reglages.joursSoir}
          />
          <button type="submit">Enregistrer la surveillance</button>
        </form>
      </Section>

      <Section
        titre="Quand vous donner des nouvelles"
        resume={rappels}
        ouvert={ouverte("rappels", rappels)}
      >
        <p className="doux">
          Les réservations de cantine ferment le lundi à minuit pour la semaine suivante.
          Choisissez les jours où vous voulez avoir de nos nouvelles. Une alerte de{" "}
          <strong>périscolaire</strong>, elle, part dès qu&apos;il manque une inscription à deux
          jours ou moins : elle ne peut pas attendre la prochaine date choisie.
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
                  avecCantine={reglages.joursCantine.length > 0}
                />
              </tbody>
            </table>
          </div>
          <button type="submit">Enregistrer les rappels</button>
        </form>
      </Section>

      <Section
        titre="Mettre la cantine en pause"
        // Une pause en cours est un etat que le parent a pose lui-meme et qui
        // s'efface seul : la section s'ouvre pour qu'il retrouve sans chercher
        // de quoi la lever.
        resume={
          enPause
            ? {
                ton: "neutre",
                texte: `En pause pour la semaine du ${formaterJour(jourDepuisIso(semaineCourante))}.`,
              }
            : {
                ton: "neutre",
                texte: `Pas de cantine la semaine du ${formaterJour(jourDepuisIso(semaineCourante))} ?`,
              }
        }
        ouvert={ouverte("pause") || enPause}
      >
        {enPause ? (
          <>
            <div className="message succes">
              Rappels de cantine suspendus pour la semaine du{" "}
              {formaterJour(jourDepuisIso(semaineCourante))}. Les alertes de périscolaire
              continuent.
            </div>
            <form action={actionReprendre}>
              <button type="submit">Reprendre les rappels de cantine</button>
            </form>
          </>
        ) : (
          <>
            <p className="doux">
              Vos enfants ne mangent pas à la cantine cette semaine ? Coupez les rappels jusqu&apos;à
              la prochaine échéance — ils reprendront seuls ensuite. Les alertes de périscolaire,
              qui se jouent sur deux jours, continueront.
            </p>
            <form action={actionPause}>
              <button type="submit" className="secondaire">
                Pas de cantine la semaine du {formaterJour(jourDepuisIso(semaineCourante))}
              </button>
            </form>
          </>
        )}
      </Section>

      <Section
        titre="Vérifier maintenant"
        // Le resume ne reprend pas la phrase d'en dessous : deux fois la meme
        // chose, c'est la seconde qu'on arrete de lire.
        resume={{ ton: "neutre", texte: "Voir l'état de la semaine sans attendre un rappel." }}
        ouvert={ouverte("verifier")}
      >
        <p className="doux">
          Interroge le portail immédiatement et affiche l&apos;état de la semaine visée, sans
          envoyer de mail.
        </p>
        <form action={actionVerifier}>
          <button type="submit" className="secondaire">
            Vérifier maintenant
          </button>
        </form>
      </Section>

      <Section
        titre="Tester l'envoi"
        resume={{ ton: "neutre", texte: "Recevoir le message qui partirait à une date donnée." }}
        ouvert={ouverte("test")}
      >
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
            defaultValue={iso(aujourdhui)}
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
      </Section>

      <form action={actionDeconnexion}>
        <button type="submit" className="secondaire">
          Se déconnecter
        </button>
      </form>
    </>
  );
}
