import { JOURS_SEMAINE_UI, libelleJourAvant, libelleJourSemaine } from "../../lib/portail/dates.ts";

/**
 * Le ton d'une section repliee.
 *
 * "ok" dit au parent qu'il n'a rien a faire ici — c'est toute la raison d'etre
 * du repli : une section fermee doit se lire sans l'ouvrir, sinon replier ne
 * fait que cacher. "attention" marque ce qui empeche le service de faire ce
 * que le parent croit ; ces sections-la s'ouvrent d'office. "neutre" ne juge
 * pas : une action possible, un outil.
 */
export type Ton = "ok" | "attention" | "neutre";

export type Resume = { ton: Ton; texte: string };

/**
 * "a", "a et b", "a, b et c".
 *
 * Une liste qui se lit a voix haute plutot qu'une enumeration technique : le
 * resume d'une section fermee est une phrase, pas un champ de formulaire.
 */
export function enumerer(elements: string[]): string {
  if (elements.length <= 1) return elements[0] ?? "";
  return `${elements.slice(0, -1).join(", ")} et ${elements[elements.length - 1]}`;
}

/**
 * Les jours de semaine tels que la grille les montre.
 *
 * On intersecte avec `JOURS_SEMAINE_UI` : tant que la famille n'a rien
 * enregistre, `joursCantine` vaut les sept jours (la base stocke l'absence de
 * cantine, donc la liste vide vaut « partout »), et le resume annoncerait un
 * samedi et un dimanche que la grille ne propose meme pas.
 */
function listeJours(jours: number[]): string {
  const retenus = JOURS_SEMAINE_UI.filter((j) => jours.includes(j));
  if (retenus.length === 0) return "";
  if (retenus.length === JOURS_SEMAINE_UI.length) return "tous les jours";
  return enumerer(retenus.map(libelleJourSemaine));
}

export function resumeIdentifiants({
  actif,
  portailEmail,
  motDePasseEnregistre,
  verifieLe,
  derniereErreur,
}: {
  actif: boolean;
  portailEmail: string | null;
  motDePasseEnregistre: boolean;
  verifieLe: Date | null;
  derniereErreur: string | null;
}): Resume {
  if (!portailEmail || !motDePasseEnregistre) {
    return { ton: "attention", texte: "À renseigner : sans eux, rien ne peut être surveillé." };
  }
  if (!actif) {
    return {
      ton: "attention",
      texte: `${portailEmail} — refusés par le portail, la surveillance est suspendue.`,
    };
  }
  // Une erreur technique du portail n'est pas une faute du parent : on la
  // signale sans la peindre en rouge, et la section reste fermee. Le detail
  // exact est a l'interieur.
  if (derniereErreur) {
    return { ton: "neutre", texte: `${portailEmail} — la dernière tentative a échoué.` };
  }
  if (!verifieLe) {
    return { ton: "neutre", texte: `${portailEmail} — pas encore vérifiés.` };
  }
  return {
    ton: "ok",
    texte: `${portailEmail} — connexion vérifiée le ${verifieLe.toLocaleDateString("fr-FR", {
      timeZone: "Europe/Paris",
    })}.`,
  };
}

export function resumeDestinataires(destinataires: string[]): Resume {
  if (destinataires.length === 0) {
    return { ton: "attention", texte: "Aucune adresse : les rappels ne partiraient nulle part." };
  }
  return { ton: "ok", texte: enumerer(destinataires) };
}

export function resumeSurveillance({
  cantine,
  matin,
  soir,
}: {
  cantine: number[];
  matin: number[];
  soir: number[];
}): Resume {
  const joursCantine = listeJours(cantine);
  const joursMatin = listeJours(matin);
  const joursSoir = listeJours(soir);

  if (!joursCantine && !joursMatin && !joursSoir) {
    return { ton: "attention", texte: "Rien de coché : aucun oubli ne sera signalé." };
  }

  const morceaux = [
    joursCantine && `Cantine ${joursCantine}`,
    joursMatin && `Matin ${joursMatin}`,
    joursSoir && `Soir ${joursSoir}`,
  ].filter((m): m is string => Boolean(m));

  // Une carte fermee doit nommer ce qu'elle ne couvre pas. Le periscolaire part
  // eteint et sans annonce : une famille ne le decouvre qu'en ouvrant cette
  // section, et la replier sur un resume qui ne parle que de cantine le rendrait
  // proprement invisible.
  if (!joursMatin && !joursSoir) morceaux.push("périscolaire non surveillé");

  // La cantine est le coeur du service : ne surveiller que la garderie reste un
  // reglage valable, mais assez inhabituel pour meriter d'etre relu.
  return {
    ton: joursCantine ? "ok" : "neutre",
    texte: `${morceaux.join(" · ")}.`,
  };
}

export function resumeRappels({
  joursAvant,
  joursSilencieux,
  avecCantine,
}: {
  joursAvant: number[];
  joursSilencieux: number[];
  avecCantine: boolean;
}): Resume {
  if (joursAvant.length === 0) {
    // `jours_avant` vide est l'interrupteur general du service, pas une simple
    // cadence : c'est ce que pose « Ne plus recevoir de rappels ». Le dire ici
    // est la seule trace visible d'un desabonnement fait depuis un mail.
    return { ton: "attention", texte: "Aucun jour choisi : vous ne recevez plus rien." };
  }
  // Les jours sont stockes en jours AVANT l'echeance (0 = lundi, 6 = mardi) :
  // les trier tels quels les rendrait a l'envers de la semaine.
  const jours = [...joursAvant].sort((a, b) => b - a);
  const muets = jours.filter((n) => joursSilencieux.includes(n)).length;
  const nuance =
    muets === jours.length
      ? " — seulement en cas d'oubli"
      : muets
        ? ` — dont ${muets} seulement en cas d'oubli`
        : "";
  return {
    ton: "ok",
    texte: `Prévenu ${enumerer(jours.map((n) => libelleJourAvant(n, { avecCantine })))}${nuance}.`,
  };
}

/**
 * L'etat global, affiche en tete de page.
 *
 * Une page faite de sections fermees ne se lit plus d'un coup d'oeil : cette
 * ligne rend ce que le repli retire, et c'est elle qui repond a la seule
 * question que le parent se pose en arrivant — « est-ce que ca marche ? ».
 */
export function etatGlobal(aCorriger: string[]): Resume {
  if (aCorriger.length === 0) {
    return { ton: "ok", texte: "Tout est en place, la surveillance tourne." };
  }
  return {
    ton: "attention",
    texte: `À compléter : ${enumerer(aCorriger)}.`,
  };
}
