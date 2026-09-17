import {
  boolean,
  date,
  index,
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
 * Les reglages d'une famille : quand lui ecrire, et ce que l'on surveille.
 *
 * Deux referentiels de jours coexistent ici, et les confondre est le piege
 * principal de cette table :
 *   - `jours_avant` compte les jours AVANT l'echeance cantine, qui est toujours
 *     un lundi. 0 = lundi (dernier jour), 1 = dimanche, ... 6 = mardi.
 *   - `jours_sans_cantine` / `jours_matin` / `jours_soir` sont des JOURS DE
 *     SEMAINE, 0 = lundi, comme `planning.jour_0` du portail.
 */
export const rappels = pgTable(
  "rappels",
  {
    parentId: uuid("parent_id")
      .primaryKey()
      .references(() => parents.id, { onDelete: "cascade" }),
    /**
     * Jours ou la famille veut des nouvelles, en J-n avant l'echeance.
     *
     * La liste vide est l'INTERRUPTEUR GENERAL : plus aucun mail, periscolaire
     * compris. C'est ce que pose le lien "Ne plus recevoir de rappels" — sans
     * quoi le periscolaire, qui ne depend pas des jours choisis, continuerait
     * d'ecrire a une famille desabonnee et le lien mentirait.
     */
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
    /**
     * Jours de semaine SANS cantine attendue. En negatif, meme raison que
     * ci-dessus : le defaut — la liste vide — doit valoir le comportement sur,
     * ici "alerter tous les jours".
     */
    joursSansCantine: integer("jours_sans_cantine").array().notNull().default([]),
    /**
     * Jours de semaine AVEC periscolaire attendu. En positif cette fois, parce
     * que le comportement sur est l'inverse : on ne peut pas alerter sur un
     * service que la famille n'utilise pas. La liste vide eteint la
     * surveillance.
     */
    joursMatin: integer("jours_matin").array().notNull().default([]),
    joursSoir: integer("jours_soir").array().notNull().default([]),
    /**
     * Semaine visee (lundi) pour laquelle le parent a dit "pas de cantine cette
     * semaine". Le cron compare a la semaine du jour : quand l'echeance passe,
     * la semaine visee change, la valeur ne correspond plus et la cantine
     * reprend SEULE. Pas de purge a prevoir, et recliquer est idempotent.
     *
     * Ne couvre que la cantine : le periscolaire garde son horizon de deux
     * jours, sur lequel une pause hebdomadaire n'aurait aucun sens.
     */
    pauseSemaine: date("pause_semaine"),
  },
  // Le cron selectionne les comptes du jour avec `jours_avant @> ARRAY[n]` :
  // sans index GIN c'est un parcours complet a chaque execution.
  (t) => [index("rappels_jours_avant_idx").using("gin", t.joursAvant)],
);

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
    /**
     * "rappel_cantine", "rappel_periscolaire" ou "confirmation".
     *
     * Le perimetre fait partie de la valeur : sans lui, un rappel de garderie
     * pose a 16 h occuperait la ligne du jour et le filet de 19 h conclurait
     * "deja notifie" si une reservation de cantine venait d'etre annulee.
     * Aucun defaut : on l'ecrit toujours explicitement.
     */
    type: text("type").notNull(),
    envoyeLe: timestamp("envoye_le", { withTimezone: true }).notNull().defaultNow(),
  },
  // `type` fait partie de la cle : un rappel et une confirmation ne se
  // remplacent pas. Sans lui, une confirmation posee par le cron de 16 h
  // occuperait le creneau et etoufferait le rappel que le passage de 19 h
  // declencherait si une reservation venait d'etre annulee — soit exactement
  // le cas que le filet est cense rattraper.
  (t) => [unique("envoi_unique").on(t.parentId, t.semaineVisee, t.joursAvant, t.type)],
);

/** On ne stocke que le hash du token : la base seule ne permet pas de se connecter. */
export const liensMagiques = pgTable(
  "liens_magiques",
  {
    tokenHash: text("token_hash").primaryKey(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => parents.id, { onDelete: "cascade" }),
    expireLe: timestamp("expire_le", { withTimezone: true }).notNull(),
    utiliseLe: timestamp("utilise_le", { withTimezone: true }),
  },
  (t) => [
    // Lu a chaque demande de lien : purge des jetons expires, et comptage des
    // jetons recents qui borne le debit d'envoi.
    index("liens_magiques_expire_le_idx").on(t.expireLe),
    // Seule cle etrangere du schema que rien d'autre ne couvre : sans elle,
    // supprimer un parent parcourt la table entiere.
    index("liens_magiques_parent_id_idx").on(t.parentId),
  ],
);
