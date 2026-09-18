import { formaterJour, formaterJourCourt, joursRestants as ecartJours } from "../portail/dates.ts";
import { urlDepot } from "../url-publique.ts";
import type { Cible, CleSurveillance } from "../portail/types.ts";
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
  /** Met la cantine en silence jusqu'a la prochaine echeance. Cf. lib/auth/pause.ts. */
  pause?: string;
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

/**
 * Un emoji ouvre l'objet de chaque message pour que l'etat se lise sans meme
 * ouvrir le mail — dans une liste de messages, c'est la seule chose qui n'est
 * jamais tronquee.
 *
 * Trois etats seulement, et des glyphes qui portent leur sens : un rond de
 * couleur ne dirait plus rien la ou le client rend les emojis en monochrome
 * (Outlook pour Windows) ni a un lecteur d'ecran, qui annonce « coche »,
 * « attention » et « gyrophare ».
 */
const EMOJI_OK = "✅";
const EMOJI_MANQUE = "⚠️";
const EMOJI_PRESSE = "🚨";

/**
 * Seuil du gyrophare pour la CANTINE : deux jours ou moins avant l'echeance.
 *
 * Volontairement plus large que `urgent`, qui vaut J-0 seul parce qu'il
 * commande des formulations vraies ce jour-la uniquement (« ce soir avant
 * minuit »). L'emoji, lui, n'affirme rien de tel : il peut prevenir plus tot.
 *
 * Ce seuil ne se transpose PAS tel quel au periscolaire. Il a ete calibre sur
 * un cycle de sept jours, ou « il reste deux jours » est vraiment la derniere
 * ligne droite ; sur un cycle de deux jours il couvrirait tout le cycle et ne
 * porterait plus aucune information. On transpose donc l'intention, pas la
 * valeur : gyrophare au dernier jour utile seulement.
 */
const SEUIL_PRESSE = 2;

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

const MOMENTS: Record<string, string> = { matin: "matin", soir: "soir" };

/**
 * Comme `grouperParEnfant`, mais un jour de periscolaire peut manquer le matin,
 * le soir, ou les deux : le moment doit accompagner le jour, sinon le parent ne
 * sait pas laquelle des deux inscriptions poser.
 */
function grouperPeriscolaire(manquants: Cible[]): GroupeJours[] {
  const parEnfant = new Map<string, Map<number, Set<CleSurveillance>>>();
  for (const m of manquants) {
    if (!parEnfant.has(m.enfant)) parEnfant.set(m.enfant, new Map());
    const jours = parEnfant.get(m.enfant)!;
    const t = m.date.getTime();
    if (!jours.has(t)) jours.set(t, new Set());
    jours.get(t)!.add(m.cle);
  }
  return [...parEnfant].map(([enfant, jours]) => ({
    enfant,
    jours: [...jours]
      .sort((a, b) => a[0] - b[0])
      .map(([t, cles]) => {
        const moments = ["matin", "soir"]
          .filter((c) => cles.has(c as CleSurveillance))
          .map((c) => MOMENTS[c]);
        return `${formaterJourCourt(new Date(t))} (${moments.join(" et ")})`;
      }),
  }));
}

const pluriel = (n: number) => (n > 1 ? "s" : "");

/** La cantine, quand elle a ete regardee aujourd'hui. */
export type SectionCantine = {
  manquants: Cible[];
  semaine: Date;
  echeance: Date;
  joursRestants: number;
};

/**
 * Le rappel du jour : un seul message, qui couvre les deux perimetres.
 *
 * Les sections gardent un ordre FIXE cantine puis periscolaire. L'encart de
 * tete et l'objet portent deja l'echeance la plus pressante, donc l'ordre du
 * corps ne joue plus sur l'urgence — seulement sur l'habitude de lecture, et un
 * message recurrent dont la structure bouge se lit moins vite.
 */
export function mailRappel({
  cantine,
  periscolaire = [],
  aujourdhui,
  liens,
}: {
  cantine: SectionCantine | null;
  periscolaire?: Cible[];
  /** Sert a dater les echeances du periscolaire, qui se comptent depuis aujourd'hui. */
  aujourdhui: Date;
  liens: Liens;
}): Mail {
  // Le perimetre cantine peut avoir ete regarde sans rien manquer — c'est le cas
  // d'un rappel declenche par le seul periscolaire. On le ramene a `null` ici
  // plutot que d'en tenir compte dans chaque calcul en aval, sans quoi le mail
  // afficherait un titre « Cantine » suivi d'une liste vide.
  const sectionC = cantine && cantine.manquants.length ? cantine : null;
  const nbCantine = sectionC?.manquants.length ?? 0;
  const nbPerisco = periscolaire.length;

  // Nombre de jours avant la fermeture, meme unite pour les deux perimetres :
  // 0 = ce soir a minuit. Pour le periscolaire, un jour D ferme au minuit qui
  // l'ouvre, donc l'ecart de dates moins un.
  const ecartsPerisco = periscolaire.map((c) => ecartJours(aujourdhui, c.date) - 1);
  const presseCantine = sectionC?.joursRestants ?? Number.POSITIVE_INFINITY;
  const pressePerisco = ecartsPerisco.length ? Math.min(...ecartsPerisco) : Number.POSITIVE_INFINITY;

  // Ex aequo : la cantine passe devant, c'est le coeur du service.
  const cantineDabord = presseCantine <= pressePerisco;
  const presse = Math.min(presseCantine, pressePerisco);

  // « Ce soir avant minuit » est vrai des que le perimetre le plus pressant
  // ferme cette nuit, cantine comme periscolaire.
  const urgent = presse === 0;
  // Gyrophare : seuil large pour la cantine, dernier jour seul pour le
  // periscolaire, cf. SEUIL_PRESSE.
  const gyrophare = presseCantine <= SEUIL_PRESSE || pressePerisco === 0;
  const emoji = gyrophare ? EMOJI_PRESSE : EMOJI_MANQUE;

  const delaiCantine = (c: SectionCantine) =>
    c.joursRestants === 0
      ? "À réserver ce soir avant minuit"
      : `À réserver avant ${formaterJour(c.echeance)}, minuit` +
        ` — dans ${c.joursRestants} jour${pluriel(c.joursRestants)}`;
  const delaiPerisco = (jours: number) =>
    jours === 0 ? "À réserver ce soir avant minuit" : "À réserver demain avant minuit";

  const delai = cantineDabord && sectionC ? delaiCantine(sectionC) : delaiPerisco(pressePerisco);

  const phraseCantine = `${nbCantine} repas non réservé${pluriel(nbCantine)}`;
  const phrasePerisco = `${nbPerisco} périscolaire${pluriel(nbPerisco)} non réservé${pluriel(nbPerisco)}`;

  const objet = construireObjet({
    emoji,
    urgent,
    cantine: sectionC,
    cantineDabord,
    nbCantine,
    nbPerisco,
    phraseCantine,
    phrasePerisco,
    periscolaire,
  });

  // Chaque section porte sa propre echeance des lors qu'elles sont deux :
  // l'encart de tete ne parle que de la plus pressante, et sans ce rappel le
  // lecteur appliquerait « ce soir avant minuit » a la cantine, qui a cinq
  // jours devant elle. Seule, la cantine garde sa formulation d'origine —
  // l'encart la porte deja, la repeter serait du bruit.
  const deuxSections = Boolean(sectionC) && nbPerisco > 0;
  const sectionCantine = sectionC
    ? [
        paragraphe(
          deuxSections
            ? `Cantine — semaine du ${formaterJour(sectionC.semaine)}. ${delaiCantine(sectionC)}.`
            : `Semaine du ${formaterJour(sectionC.semaine)}.`,
          { doux: true },
        ),
        joursParEnfant(grouperParEnfant(sectionC.manquants)),
      ]
    : [];
  const sectionPerisco = nbPerisco
    ? [
        paragraphe("Périscolaire — à réserver la veille avant minuit.", { doux: true }),
        joursParEnfant(grouperPeriscolaire(periscolaire)),
      ]
    : [];

  return rendreMail({
    objet,
    preheader: `${delai}.`,
    blocs: [
      encart({ texte: delai, ton: urgent ? "urgent" : "info" }),
      titre(`${phrasesCumulees(nbCantine, nbPerisco, phraseCantine, phrasePerisco, cantineDabord)}`),
      bouton({ libelle: "Réserver maintenant", url: liens.reservation }),
      separateur(),
      ...sectionCantine,
      ...(sectionCantine.length && sectionPerisco.length ? [separateur()] : []),
      ...sectionPerisco,
      // Le bouton de pause ne vaut que pour la cantine : l'afficher sur un
      // message qui ne parle que de garderie promettrait un silence qu'il ne
      // tient pas.
      ...(nbCantine && liens.pause
        ? [
            separateur(),
            paragraphe(
              "Vos enfants ne mangent pas à la cantine cette semaine ? Coupez les rappels " +
                "jusqu'à la prochaine échéance. Les alertes de périscolaire continueront.",
              { doux: true },
            ),
            bouton({
              libelle: "Pas de cantine cette semaine",
              url: liens.pause,
              ton: "secondaire",
            }),
          ]
        : []),
    ],
    pied: pied(liens),
  });
}

/** « 3 repas » / « 2 périscolaires et 3 repas », avec l'accord sur le total. */
function phrasesCumulees(
  nbCantine: number,
  nbPerisco: number,
  phraseCantine: string,
  phrasePerisco: string,
  cantineDabord: boolean,
): string {
  if (!nbPerisco) return phraseCantine;
  if (!nbCantine) return phrasePerisco;
  const total = nbCantine + nbPerisco;
  const [a, b] = cantineDabord
    ? [`${nbCantine} repas`, `${nbPerisco} périscolaire${pluriel(nbPerisco)}`]
    : [`${nbPerisco} périscolaire${pluriel(nbPerisco)}`, `${nbCantine} repas`];
  return `${a} et ${b} non réservé${pluriel(total)}`;
}

/**
 * L'apercu mobile tronque : l'objet epouse le perimetre le plus pressant et
 * relegue l'autre en suffixe. Un objet a parts egales rendrait « Dernier jour »
 * litteralement faux pour l'un des deux.
 */
function construireObjet({
  emoji,
  urgent,
  cantine,
  cantineDabord,
  nbCantine,
  nbPerisco,
  phraseCantine,
  phrasePerisco,
  periscolaire,
}: {
  emoji: string;
  urgent: boolean;
  cantine: SectionCantine | null;
  cantineDabord: boolean;
  nbCantine: number;
  nbPerisco: number;
  phraseCantine: string;
  phrasePerisco: string;
  periscolaire: Cible[];
}): string {
  // Cantine seule : les formulations d'origine, au caractere pres. Une famille
  // qui n'utilise pas le periscolaire ne doit voir aucun changement.
  if (cantine && !nbPerisco) {
    return urgent
      ? `${emoji} Dernier jour — ${phraseCantine} pour la semaine du ${formaterJour(cantine.semaine)}`
      : `${emoji} ${phraseCantine} · semaine du ${formaterJour(cantine.semaine)}`;
  }

  if (!cantine || !nbCantine) {
    const jours = [...new Set(periscolaire.map((c) => formaterJourCourt(c.date)))].join(" et ");
    return urgent
      ? `${emoji} Dernier jour — ${phrasePerisco}`
      : `${emoji} ${phrasePerisco} · ${jours}`;
  }

  const principal = cantineDabord ? phraseCantine : phrasePerisco;
  const suffixe = cantineDabord
    ? ` · et ${nbPerisco} périscolaire${pluriel(nbPerisco)}`
    : ` · et ${nbCantine} repas`;
  return urgent
    ? `${emoji} Dernier jour — ${principal}${suffixe}`
    : `${emoji} ${principal}${suffixe}`;
}

/**
 * La confirmation : « rien a faire », sur le perimetre REELLEMENT regarde.
 *
 * Deux lignes distinctes plutot qu'une phrase globale : la cantine se confirme
 * sur une semaine, le periscolaire sur deux jours. Un « tout est reserve »
 * affirmerait une couverture du periscolaire sur des jours qu'on n'a jamais
 * regardes.
 */
export function mailConfirmation({
  cantine,
  periscolaire = null,
  liens,
}: {
  cantine: { semaine: Date; echeance: Date; reserves: number } | null;
  /** Les jours de periscolaire regardes aujourd'hui, s'il y en avait. */
  periscolaire?: { jours: Date[] } | null;
  liens: Liens;
}): Mail {
  const joursPerisco = periscolaire?.jours ?? [];
  const listePerisco = joursPerisco.map(formaterJourCourt).join(" et ");

  return rendreMail({
    objet: cantine
      ? `${EMOJI_OK} Tout est réservé · semaine du ${formaterJour(cantine.semaine)}`
      : `${EMOJI_OK} Rien à réserver · ${listePerisco}`,
    preheader: cantine
      ? "Rien à faire, la semaine est couverte."
      : "Rien à faire pour le périscolaire.",
    blocs: [
      encart({ texte: "Rien à faire, tout est réservé", ton: "succes" }),
      titre(cantine ? `Semaine du ${formaterJour(cantine.semaine)}` : "Rien à réserver"),
      // Present, et non passe : `prochaineEcheance()` rend le prochain lundi,
      // aujourd'hui inclus. L'echeance est donc toujours a venir quand ce
      // message part — a J-0 elle tombe le soir meme. L'annoncer au passe
      // laisse croire que la semaine est close et qu'il n'y a plus rien a
      // corriger, alors qu'une annulation reste possible jusqu'a minuit.
      ...(cantine
        ? [
            paragraphe(
              `Les ${cantine.reserves} repas de la semaine sont réservés. La date limite est ` +
                `${formaterJour(cantine.echeance)} à minuit.`,
            ),
          ]
        : []),
      ...(joursPerisco.length
        ? [paragraphe(`Périscolaire : rien à réserver ${listePerisco}.`)]
        : []),
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
