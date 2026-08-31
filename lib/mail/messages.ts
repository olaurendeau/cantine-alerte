import { formaterJour, formaterJourCourt } from "../portail/dates.ts";
import { urlDepot } from "../url-publique.ts";
import type { Cible } from "../portail/types.ts";
import {
  bouton,
  encart,
  joursParEnfant,
  paragraphe,
  piedDePage,
  rendreMail,
  separateur,
  titre,
  type GroupeJours,
  type Mail,
} from "./gabarit.ts";

/**
 * Composition des messages envoyes aux parents.
 *
 * Le texte de ces messages est en francais correctement accentue : il est lu
 * par des familles, pas par un terminal. La convention « sans accents » du
 * depot continue de s'appliquer aux identifiants, aux commentaires et aux
 * journaux techniques.
 */

export type Liens = {
  /** Le portail de reservation, ou le parent doit agir. */
  reservation: string;
  reglages: string;
  desabonnement?: string;
};

const pied = (liens: Liens) =>
  piedDePage([
    { libelle: "Mes réglages", url: liens.reglages },
    ...(liens.desabonnement
      ? [{ libelle: "Ne plus recevoir de rappels", url: liens.desabonnement }]
      : []),
    // Le service détient le mot de passe du portail de la famille : pouvoir
    // aller lire ce qu'il en fait n'est pas un détail de pied de page.
    { libelle: "Code source", url: urlDepot() },
  ]);

/** Un groupe par enfant, les jours dans l'ordre chronologique. */
function grouperParEnfant(manquants: Cible[]): GroupeJours[] {
  const parEnfant = new Map<string, Date[]>();
  for (const m of [...manquants].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    if (!parEnfant.has(m.enfant)) parEnfant.set(m.enfant, []);
    parEnfant.get(m.enfant)!.push(m.date);
  }
  return [...parEnfant].map(([enfant, dates]) => ({
    enfant,
    jours: dates.map(formaterJourCourt),
  }));
}

export function mailRappel({
  manquants,
  semaine,
  echeance,
  joursRestants,
  urgent,
  liens,
}: {
  manquants: Cible[];
  semaine: Date;
  echeance: Date;
  joursRestants: number;
  urgent: boolean;
  liens: Liens;
}): Mail {
  const nb = manquants.length;
  const repas = `${nb} repas non réservé${nb > 1 ? "s" : ""}`;
  const delai = urgent
    ? "À réserver ce soir avant minuit"
    : `À réserver avant ${formaterJour(echeance)}, minuit` +
      (joursRestants > 0 ? ` — dans ${joursRestants} jour${joursRestants > 1 ? "s" : ""}` : "");

  return rendreMail({
    // L'aperçu mobile tronque : l'information utile passe devant le nom du
    // service, qui est de toute façon visible sur la ligne de l'expéditeur.
    objet: urgent
      ? `Dernier jour — ${repas} pour la semaine du ${formaterJour(semaine)}`
      : `${repas} · semaine du ${formaterJour(semaine)}`,
    preheader: `${delai}.`,
    blocs: [
      encart({ texte: delai, ton: urgent ? "urgent" : "info" }),
      titre(repas),
      paragraphe(`Semaine du ${formaterJour(semaine)}.`, { doux: true }),
      bouton({ libelle: "Réserver maintenant", url: liens.reservation }),
      separateur(),
      joursParEnfant(grouperParEnfant(manquants)),
    ],
    pied: pied(liens),
  });
}

export function mailConfirmation({
  semaine,
  echeance,
  reserves,
  liens,
}: {
  semaine: Date;
  echeance: Date;
  reserves: number;
  liens: Liens;
}): Mail {
  return rendreMail({
    objet: `Tout est réservé · semaine du ${formaterJour(semaine)}`,
    preheader: "Rien à faire, la semaine est couverte.",
    blocs: [
      encart({ texte: "Rien à faire, tout est réservé", ton: "succes" }),
      titre(`Semaine du ${formaterJour(semaine)}`),
      // Present, et non passe : `prochaineEcheance()` rend le prochain lundi,
      // aujourd'hui inclus. L'echeance est donc toujours a venir quand ce
      // message part — a J-0 elle tombe le soir meme. L'annoncer au passe
      // laisse croire que la semaine est close et qu'il n'y a plus rien a
      // corriger, alors qu'une annulation reste possible jusqu'a minuit.
      paragraphe(
        `Les ${reserves} repas de la semaine sont réservés. La date limite est ` +
          `${formaterJour(echeance)} à minuit.`,
      ),
      paragraphe(
        "Ce message vous confirme que la surveillance fonctionne. Vous pouvez le " +
          "désactiver jour par jour dans vos réglages.",
        { doux: true },
      ),
      // Secondaire : le message dit qu'il n'y a rien à faire, le bouton ne doit
      // pas dire le contraire.
      bouton({ libelle: "Vérifier sur le portail", url: liens.reservation, ton: "secondaire" }),
    ],
    pied: pied(liens),
  });
}

export function mailLienConnexion({
  lien,
  dureeMinutes,
}: {
  lien: string;
  dureeMinutes: number;
}): Mail {
  return rendreMail({
    objet: "Votre lien de connexion",
    preheader: `Valable ${dureeMinutes} minutes, à usage unique.`,
    blocs: [
      titre("Connexion à Alerte cantine"),
      paragraphe("Cliquez sur le bouton ci-dessous pour accéder à vos réglages."),
      bouton({ libelle: "Ouvrir ma session", url: lien }),
      paragraphe(
        `Ce lien expire dans ${dureeMinutes} minutes et ne fonctionne qu'une seule fois. ` +
          "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.",
        { doux: true },
      ),
    ],
  });
}

export function mailEchecParent({
  invalides,
  detail,
  echecs,
  seuil,
  desactive,
  liens,
}: {
  invalides: boolean;
  detail: string;
  echecs: number;
  seuil: number;
  desactive: boolean;
  liens: Liens;
}): Mail {
  const objet = invalides
    ? "Vos identifiants du portail ne fonctionnent plus"
    : "La vérification n'a pas pu aboutir";

  return rendreMail({
    objet,
    // Le vrai enjeu n'est pas la panne mais ce qu'elle implique : plus personne
    // ne surveille les réservations. On le dit dès l'aperçu.
    preheader: "Vos réservations ne sont plus surveillées pour le moment.",
    blocs: [
      encart({ texte: "Vos réservations ne sont plus surveillées", ton: "urgent" }),
      titre(objet),
      paragraphe(
        invalides
          ? "La connexion au portail a été refusée avec les identifiants enregistrés."
          : "Le portail n'a pas répondu correctement après plusieurs tentatives. " +
              "Il s'agit vraisemblablement d'un incident passager : vos identifiants " +
              "ne sont pas en cause.",
      ),
      paragraphe(`Motif : ${detail}`, { doux: true }),
      paragraphe(
        desactive
          ? "Les rappels sont suspendus jusqu'à la mise à jour de vos identifiants."
          : invalides
            ? `Nouvel essai au prochain rappel (échec ${echecs} sur ${seuil}).`
            : "Nouvel essai au prochain rappel, sans action de votre part.",
      ),
      ...(invalides
        ? [bouton({ libelle: "Mettre à jour mes identifiants", url: liens.reglages })]
        : []),
      paragraphe(
        "En attendant, pensez à vérifier vos réservations directement sur le portail.",
        { doux: true },
      ),
    ],
    pied: pied(liens),
  });
}

export function mailEchecAdmin({
  compte,
  invalides,
  detail,
  echecs,
  desactive,
  objetParent,
}: {
  compte: string;
  invalides: boolean;
  detail: string;
  echecs: number;
  desactive: boolean;
  objetParent: string;
}): Mail {
  return rendreMail({
    objet: `[admin] ${objetParent} — ${compte}`,
    preheader: `${echecs} échec(s) consécutif(s)${desactive ? ", compte désactivé" : ""}.`,
    blocs: [
      encart({
        texte: desactive ? "Compte désactivé" : `${echecs} échec(s) consécutif(s)`,
        ton: desactive ? "urgent" : "info",
      }),
      titre("Échec de vérification"),
      // L'administrateur voit qui est en panne et pourquoi, jamais les
      // identifiants de la famille.
      paragraphe(`Compte : ${compte}`),
      paragraphe(`Type : ${invalides ? "identifiants refusés" : "erreur technique"}`),
      paragraphe(`Motif : ${detail}`, { doux: true }),
    ],
  });
}
