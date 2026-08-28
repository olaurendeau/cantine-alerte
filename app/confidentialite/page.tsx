export const metadata = { title: "Ce que nous stockons — Alerte cantine" };

/**
 * Page volontairement franche. Le service peut techniquement dechiffrer les
 * mots de passe : le dire clairement vaut mieux qu'une formule rassurante et
 * fausse, et le code etant public, l'affirmation est verifiable.
 */
export default function Confidentialite() {
  return (
    <>
      <h1>Ce que nous stockons, et pourquoi</h1>
      <p className="doux">
        <a href="/reglages">Retour</a>
      </p>

      <section className="carte">
        <h2>Les donnees conservees</h2>
        <ul>
          <li>Votre adresse email de connexion.</li>
          <li>Les adresses destinataires des rappels (souvent les deux parents).</li>
          <li>Votre identifiant et votre mot de passe du portail de la cantine.</li>
          <li>Les jours ou vous souhaitez etre rappele.</li>
          <li>La date des dernieres verifications et des rappels envoyes.</li>
        </ul>
        <p>
          Les prenoms de vos enfants sont lus sur le portail au moment de la verification pour
          rediger le rappel. Ils ne sont pas enregistres.
        </p>
      </section>

      <section className="carte">
        <h2>Le mot de passe du portail</h2>
        <p>
          Il est chiffre (AES-256-GCM) avant d&apos;etre enregistre. La cle de chiffrement ne se
          trouve pas dans la base de donnees : une copie de la base ne permet donc pas de retrouver
          les mots de passe. Le chiffre est de plus lie a votre compte, il ne peut pas etre
          reutilise ailleurs. L&apos;interface ne le reaffiche jamais et aucune page ne permet de le
          relire : vous pouvez seulement le remplacer.
        </p>
        <p>
          <strong>
            Il faut etre clair : le service est techniquement capable de dechiffrer votre mot de
            passe.
          </strong>{" "}
          C&apos;est inevitable, puisqu&apos;il doit se connecter au portail a votre place pendant
          que vous n&apos;etes pas la. Ce n&apos;est donc pas du « chiffrement de bout en bout », et
          nous ne pretendons pas etre dans l&apos;incapacite de lire ce mot de passe. Le
          dechiffrement n&apos;a lieu qu&apos;au moment d&apos;interroger le portail.
        </p>
        <p>
          Le code de ce service est public : cette promesse est verifiable plutot que declarative.
        </p>
      </section>

      <section className="carte">
        <h2>Ce que nous ne faisons pas</h2>
        <ul>
          <li>Aucune reservation n&apos;est posee a votre place : le service se contente de lire.</li>
          <li>Aucune donnee n&apos;est transmise a un tiers, en dehors de l&apos;envoi des mails.</li>
          <li>
            L&apos;administrateur du service voit la liste des comptes et leur etat de
            fonctionnement, jamais les identifiants des familles.
          </li>
        </ul>
      </section>

      <section className="carte">
        <h2>Supprimer vos donnees</h2>
        <p>
          La suppression de votre compte efface l&apos;ensemble des donnees ci-dessus, y compris le
          mot de passe chiffre. Ecrivez a l&apos;administrateur du service pour en faire la demande.
        </p>
      </section>
    </>
  );
}
