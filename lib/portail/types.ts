/** Config d'acces au portail d'une collectivite, plus les identifiants d'un parent. */
export type ConfigPortail = {
  email: string;
  password: string;
  bdd: string;
  apiKey: string;
  dbId: string;
  typeId: string;
  portail: string;
  /** Regex testee sur le code et le libelle de la prestation a surveiller. */
  prestation: RegExp;
  /** Jours a ignorer (YYYY-MM-DD) que le portail ne sait pas ecarter lui-meme. */
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
  prestation: string;
  code: string;
};
