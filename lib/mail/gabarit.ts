/**
 * Gabarit des mails : un modele de blocs qui rend simultanement une version
 * HTML et une version texte.
 *
 * Les deux sortent de la meme source a dessein. Le travers habituel du mail
 * HTML est une version texte ecrite une fois puis oubliee, qui finit par ne
 * plus dire la meme chose que le HTML. Ici, ajouter un bloc oblige a ecrire
 * ses deux rendus.
 *
 * Contraintes de rendu, apprises des clients mail et non negociables :
 *
 * - Mise en page en TABLEAUX, styles EN LIGNE. Gmail supprime <style> pour les
 *   comptes non-Gmail, et Outlook rend via le moteur de Word : ni flexbox ni
 *   grid. Les regles du <style> ne servent que d'amelioration progressive.
 * - Bouton construit en tableau, pas un <a> stylé : Outlook ignore padding et
 *   background sur un lien seul, le bouton y deviendrait un texte nu.
 * - Aucune image externe : pas de logo a charger, donc rien a bloquer.
 * - Ni blanc ni noir purs, pour rester lisible quand un client inverse les
 *   couleurs de force en mode sombre.
 */

export type Bloc = { html: string; texte: string };

export type Mail = { objet: string; html: string; texte: string };

/** Palette alignee sur celle de l'application (app/globals.css). */
const C = {
  fond: "#f4f3f0",
  carte: "#fdfdfc",
  texte: "#1c1b1a",
  doux: "#6b6863",
  bord: "#e6e3de",
  accent: "#1f6feb",
  accentFond: "#eef4fe",
  alerte: "#b4342a",
  alerteFond: "#fdf0ee",
  ok: "#216e4e",
  okFond: "#eef6f2",
};

const POLICE =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Les prenoms viennent du portail et les motifs d'erreur de messages tiers :
 * tout ce qui n'est pas litteral doit passer par ici. En texte brut le risque
 * n'existait pas ; en HTML c'est une injection.
 */
export function echapper(valeur: string): string {
  return valeur
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const cellule = (contenu: string, padding = "0 28px") =>
  `<tr><td class="marge" style="padding:${padding};">${contenu}</td></tr>`;

// ---------------------------------------------------------------------------
// Blocs
// ---------------------------------------------------------------------------

export function titre(texte: string): Bloc {
  return {
    html: cellule(
      `<h1 style="margin:0;font:700 22px/1.3 ${POLICE};color:${C.texte};">${echapper(texte)}</h1>`,
      "0 28px 6px",
    ),
    texte: `${texte}\n${"=".repeat(Math.min(texte.length, 60))}`,
  };
}

export function paragraphe(texte: string, options: { doux?: boolean } = {}): Bloc {
  const couleur = options.doux ? C.doux : C.texte;
  const taille = options.doux ? "14px" : "16px";
  return {
    html: cellule(
      `<p style="margin:0 0 14px;font:400 ${taille}/1.55 ${POLICE};color:${couleur};">` +
        `${echapper(texte)}</p>`,
    ),
    texte,
  };
}

export type Ton = "info" | "urgent" | "succes";

const TONS: Record<Ton, { trait: string; fond: string; marque: string }> = {
  info: { trait: C.accent, fond: C.accentFond, marque: "" },
  urgent: { trait: C.alerte, fond: C.alerteFond, marque: "/!\\ " },
  succes: { trait: C.ok, fond: C.okFond, marque: "" },
};

/**
 * Encart de tete. Porte l'echeance dans un rappel : c'est l'information qui
 * decide de l'action, elle arrive donc avant le decompte et avant le detail.
 */
export function encart({ texte, ton = "info" }: { texte: string; ton?: Ton }): Bloc {
  const { trait, fond, marque } = TONS[ton];
  return {
    html: cellule(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `style="background:${fond};border-left:4px solid ${trait};border-radius:0 8px 8px 0;">` +
        `<tr><td style="padding:14px 16px;font:600 16px/1.4 ${POLICE};color:${trait};">` +
        `${echapper(texte)}</td></tr></table>`,
      "0 28px 20px",
    ),
    texte: `${marque}${texte}`,
  };
}

/**
 * Bouton en tableau : Outlook ignore padding et background sur un <a> seul, le
 * bouton y deviendrait un lien texte perdu au milieu du message.
 */
export function bouton({
  libelle,
  url,
  ton = "principal",
}: {
  libelle: string;
  url: string;
  /**
   * Le poids visuel doit suivre l'urgence reelle. Un bouton plein sur un
   * message qui dit « rien a faire » invite a cliquer sans raison.
   */
  ton?: "principal" | "secondaire";
}): Bloc {
  const principal = ton === "principal";
  const fond = principal ? C.accent : C.carte;
  const encre = principal ? "#ffffff" : C.texte;
  const bordure = principal ? C.accent : C.bord;
  return {
    html: cellule(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px;">` +
        `<tr><td align="center" bgcolor="${fond}" style="border-radius:8px;border:1px solid ${bordure};">` +
        `<a href="${echapper(url)}" style="display:block;padding:${principal ? "14px 30px" : "12px 24px"};` +
        `font:600 ${principal ? "16px" : "15px"}/1 ${POLICE};color:${encre};text-decoration:none;border-radius:8px;">` +
        `${echapper(libelle)}</a></td></tr></table>`,
    ),
    // En texte, l'URL doit etre lisible telle quelle : personne ne peut cliquer
    // sur un libelle.
    texte: `${libelle} : ${url}`,
  };
}

export type GroupeJours = { enfant: string; jours: string[] };

/**
 * Detail des jours manquants.
 *
 * Regroupe par enfant, sauf quand tous ont exactement les memes jours — le cas
 * courant d'une fratrie — auquel cas on rend une liste unique. Sinon le mail
 * repete deux fois la meme chose, ce qui allonge sans informer.
 */
export function joursParEnfant(groupes: GroupeJours[]): Bloc {
  const memesJours =
    groupes.length > 1 &&
    groupes.every((g) => g.jours.join("|") === groupes[0].jours.join("|"));

  const sections = memesJours
    ? [{ enfant: groupes.map((g) => g.enfant).join(", "), jours: groupes[0].jours }]
    : groupes;

  const html = sections
    .map(
      (s) =>
        `<p style="margin:0 0 4px;font:600 15px/1.4 ${POLICE};color:${C.texte};">` +
        `${echapper(s.enfant)}</p>` +
        `<p style="margin:0 0 16px;font:400 15px/1.6 ${POLICE};color:${C.doux};">` +
        `${s.jours.map(echapper).join(" &middot; ")}</p>`,
    )
    .join("");

  return {
    html: cellule(html),
    texte: sections.map((s) => `${s.enfant}\n  ${s.jours.join(" · ")}`).join("\n\n"),
  };
}

export function separateur(): Bloc {
  return {
    html: cellule(
      `<div style="height:1px;background:${C.bord};line-height:1px;font-size:0;">&nbsp;</div>`,
      "8px 28px 20px",
    ),
    texte: "—".repeat(30),
  };
}

/** Menu du pied de page. Chaque lien porte son URL dans la version texte. */
export function piedDePage(liens: { libelle: string; url: string }[]): Bloc {
  const html =
    `<p style="margin:0;font:400 13px/1.6 ${POLICE};color:${C.doux};">` +
    liens
      .map(
        (l) =>
          // nowrap : sans cela un libelle en deux mots se coupe en fin de ligne
          // sur mobile, et « Code source » se lit sur deux lignes.
          `<a href="${echapper(l.url)}" style="color:${C.doux};text-decoration:underline;` +
          `white-space:nowrap;">${echapper(l.libelle)}</a>`,
      )
      .join(" &nbsp;&middot;&nbsp; ") +
    `</p>`;
  return {
    html,
    texte: liens.map((l) => `${l.libelle} : ${l.url}`).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Coquille
// ---------------------------------------------------------------------------

/**
 * Texte masque affiche par les clients a cote de l'objet. C'est le pilier de la
 * lecture mobile : l'echeance doit se lire dans la liste des messages, sans
 * ouvrir le mail. Les caracteres invisibles qui suivent empechent le client
 * d'aller chercher le debut du corps pour completer l'apercu.
 */
const preheaderHtml = (texte: string) =>
  `<div style="display:none;max-height:0;max-width:0;opacity:0;overflow:hidden;` +
  `mso-hide:all;font-size:1px;line-height:1px;color:${C.fond};">${echapper(texte)}` +
  "&#847;&zwnj;&nbsp;".repeat(60) +
  "</div>";

export function rendreMail({
  objet,
  preheader,
  blocs,
  pied,
}: {
  objet: string;
  preheader: string;
  blocs: Bloc[];
  pied?: Bloc;
}): Mail {
  const corps = blocs.map((b) => b.html).join("");

  const html = `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${echapper(objet)}</title>
<style>
/* Amelioration progressive : ignoree par les clients qui suppriment <style>. */
@media only screen and (max-width:620px){
  .conteneur{width:100%!important}
  .marge{padding-left:20px!important;padding-right:20px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:${C.fond};-webkit-text-size-adjust:100%;">
${preheaderHtml(preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.fond};">
<tr><td align="center" style="padding:24px 12px 32px;">
<table role="presentation" class="conteneur" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${C.carte};border:1px solid ${C.bord};border-radius:14px;">
<tr><td style="height:28px;line-height:28px;font-size:0;">&nbsp;</td></tr>
${corps}
<tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>
</table>
${pied ? `<table role="presentation" class="conteneur" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;"><tr><td class="marge" align="center" style="padding:18px 28px 0;">${pied.html}</td></tr></table>` : ""}
</td></tr>
</table>
</body></html>`;

  const texte = [...blocs.map((b) => b.texte), ...(pied ? ["", "—", pied.texte] : [])]
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { objet, html, texte };
}
