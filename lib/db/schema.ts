import {
  boolean,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Un compte = un foyer. `email` est l'identite de connexion (lien magique) ;
 * les destinataires des rappels sont une liste separee, cf. `destinataires`.
 */
export const parents = pgTable("parents", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  actif: boolean("actif").notNull().default(true),
});

/**
 * Destinataires des rappels : en general les deux parents pour un seul compte
 * portail. Distincts de l'email de connexion, qui peut ne pas vouloir recevoir
 * les rappels ou avoir change.
 */
export const destinataires = pgTable(
  "destinataires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => parents.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    ajouteLe: timestamp("ajoute_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("destinataire_unique").on(t.parentId, t.email)],
);

/**
 * Le secret vit dans sa propre table : les requetes courantes (lister les
 * parents a notifier, afficher les reglages) n'ont aucune raison de le charger.
 */
export const identifiantsPortail = pgTable("identifiants_portail", {
  parentId: uuid("parent_id")
    .primaryKey()
    .references(() => parents.id, { onDelete: "cascade" }),
  portailEmail: text("portail_email").notNull(),
  /** Format "<iv base64>:<tag base64>:<chiffre base64>", cf. lib/crypto.ts */
  mdpChiffre: text("mdp_chiffre").notNull(),
  /** Permet de re-chiffrer par lots lors d'une rotation de cle. */
  cleVersion: integer("cle_version").notNull().default(1),
  /** Derniere connexion reussie au portail. Affiche au parent et a l'admin. */
  verifieLe: timestamp("verifie_le", { withTimezone: true }),
  echecsConsecutifs: integer("echecs_consecutifs").notNull().default(0),
  derniereErreur: text("derniere_erreur"),
  /**
   * Date du dernier mail d'alerte pour cette serie d'echecs. Remise a null a la
   * premiere reussite : on previent une fois par panne, pas une fois par jour.
   */
  alerteEchecLe: timestamp("alerte_echec_le", { withTimezone: true }),
});

/**
 * Jours de rappel, en nombre de jours avant l'echeance. L'echeance etant
 * toujours un lundi : 0 = lundi (dernier jour), 1 = dimanche, 2 = samedi...
 * Au-dela de 6 on retomberait sur l'echeance precedente.
 */
export const rappels = pgTable("rappels", {
  parentId: uuid("parent_id")
    .primaryKey()
    .references(() => parents.id, { onDelete: "cascade" }),
  joursAvant: integer("jours_avant").array().notNull().default([1]),
  /**
   * Jours ou l'on n'ecrit PAS quand tout est deja reserve.
   *
   * Exprime en negatif a dessein : la liste vide, donc le defaut, signifie
   * "confirmer tous les jours choisis". Un silence est ambigu pour le parent —
   * il ne peut pas distinguer "rien a faire" d'un service en panne — donc la
   * confirmation est le comportement par defaut, et ajouter un jour de rappel
   * n'oblige pas a penser a l'activer.
   */
  joursSilencieux: integer("jours_silencieux").array().notNull().default([]),
});

/**
 * Trace des envois. La contrainte d'unicite est l'anti-doublon : le cron peut
 * etre rejoue (redeploiement, declenchement manuel, filet GitHub Actions) sans
 * renvoyer deux fois le meme rappel.
 */
export const envois = pgTable(
  "envois",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => parents.id, { onDelete: "cascade" }),
    semaineVisee: date("semaine_visee").notNull(),
    joursAvant: integer("jours_avant").notNull(),
    /** "rappel" (des repas manquent) ou "confirmation" (tout est reserve). */
    type: text("type").notNull().default("rappel"),
    envoyeLe: timestamp("envoye_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("envoi_unique").on(t.parentId, t.semaineVisee, t.joursAvant)],
);

/** On ne stocke que le hash du token : la base seule ne permet pas de se connecter. */
export const liensMagiques = pgTable("liens_magiques", {
  tokenHash: text("token_hash").primaryKey(),
  parentId: uuid("parent_id")
    .notNull()
    .references(() => parents.id, { onDelete: "cascade" }),
  expireLe: timestamp("expire_le", { withTimezone: true }).notNull(),
  utiliseLe: timestamp("utilise_le", { withTimezone: true }),
});
