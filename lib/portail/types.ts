/**
 * Les trois prestations surveillees. Elles ne partagent PAS la meme regle de
 * reservation : la cantine ferme le lundi minuit pour la semaine suivante, le
 * periscolaire la veille a minuit. Cf. lib/portail/dates.ts.
 */
export type CleSurveillance = "cantine" | "matin" | "soir";

export const CLES_SURVEILLANCE: readonly CleSurveillance[] = ["cantine", "matin", "soir"];

/** Comment on nomme chaque surveillance a un parent. */
export const LIBELLES_SURVEILLANCE: Record<CleSurveillance, string> = {
  cantine: "cantine",
  matin: "périscolaire du matin",
  soir: "périscolaire du soir",
};

/** Config d'acces au portail d'une collectivite, plus les identifiants d'un parent. */
export type ConfigPortail = {
  email: string;
  password: string;
  bdd: string;
  apiKey: string;
  dbId: string;
  typeId: string;
  portail: string;
  /** Regex testee sur le code et le libelle de la prestation, une par surveillance. */
  motifs: Record<CleSurveillance, RegExp>;
  /**
   * Jours a ignorer (YYYY-MM-DD) que le portail ne sait pas ecarter lui-meme.
   *
   * Ne s'applique QU'A LA CANTINE : le cas d'usage est la sortie scolaire avec
   * pique-nique, qui supprime le repas mais pas la garderie du matin. C'est
   * `fenetresPour` qui ne les pose que sur la fenetre cantine.
   */
  exclusions: Set<string>;
};

/** Trace injectee : le POC ecrivait sur console.error via une globale. */
export type Logger = (...args: unknown[]) => void;

export const silencieux: Logger = () => {};

/** Un pointage tel que le renvoie /api/adulte/prestations. */
export type Pointage = {
  fkprestation: string | number;
  fkindividu: string | number;
  date: string;
  type: string;
  etat: number;
  code_etat: string;
  disabled: boolean;
  fkfacture: number | null;
};

export type Cible = {
  date: Date;
  enfant: string;
  /** Libelle rendu par le portail ("Repas enfant"), pour l'affichage. */
  prestation: string;
  /** Surveillance a laquelle ce pointage se rattache, pour grouper les mails. */
  cle: CleSurveillance;
  code: string;
};
