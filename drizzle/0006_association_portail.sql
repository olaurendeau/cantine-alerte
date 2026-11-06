CREATE TABLE "associations_portail" (
	"parent_id" uuid PRIMARY KEY NOT NULL,
	"chiffree" text NOT NULL,
	"demandee_le" timestamp with time zone NOT NULL,
	"expire_le" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "associations_portail" ADD CONSTRAINT "associations_portail_parent_id_parents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade ON UPDATE no action;