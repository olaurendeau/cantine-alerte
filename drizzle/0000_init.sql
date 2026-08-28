CREATE TABLE "destinataires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"email" text NOT NULL,
	"ajoute_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destinataire_unique" UNIQUE("parent_id","email")
);
--> statement-breakpoint
CREATE TABLE "envois" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid NOT NULL,
	"semaine_visee" date NOT NULL,
	"jours_avant" integer NOT NULL,
	"envoye_le" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "envoi_unique" UNIQUE("parent_id","semaine_visee","jours_avant")
);
--> statement-breakpoint
CREATE TABLE "identifiants_portail" (
	"parent_id" uuid PRIMARY KEY NOT NULL,
	"portail_email" text NOT NULL,
	"mdp_chiffre" text NOT NULL,
	"cle_version" integer DEFAULT 1 NOT NULL,
	"verifie_le" timestamp with time zone,
	"echecs_consecutifs" integer DEFAULT 0 NOT NULL,
	"derniere_erreur" text,
	"alerte_echec_le" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "liens_magiques" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"parent_id" uuid NOT NULL,
	"expire_le" timestamp with time zone NOT NULL,
	"utilise_le" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "parents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"cree_le" timestamp with time zone DEFAULT now() NOT NULL,
	"actif" boolean DEFAULT true NOT NULL,
	CONSTRAINT "parents_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "rappels" (
	"parent_id" uuid PRIMARY KEY NOT NULL,
	"jours_avant" integer[] DEFAULT '{1}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "destinataires" ADD CONSTRAINT "destinataires_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envois" ADD CONSTRAINT "envois_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identifiants_portail" ADD CONSTRAINT "identifiants_portail_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liens_magiques" ADD CONSTRAINT "liens_magiques_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rappels" ADD CONSTRAINT "rappels_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;