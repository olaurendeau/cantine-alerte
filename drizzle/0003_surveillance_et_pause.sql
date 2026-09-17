ALTER TABLE "envois" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "rappels" ADD COLUMN "jours_sans_cantine" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "rappels" ADD COLUMN "jours_matin" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "rappels" ADD COLUMN "jours_soir" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "rappels" ADD COLUMN "pause_semaine" date;--> statement-breakpoint
-- Migration de donnees, ajoutee a la main : drizzle-kit ne voit que le schema.
-- Le perimetre entre dans `type`, donc les lignes historiques doivent adopter
-- la nouvelle valeur. Sans ceci, elles n'entrent plus en collision avec les
-- nouvelles et chaque famille recevrait un doublon le jour du deploiement.
UPDATE "envois" SET "type" = 'rappel_cantine' WHERE "type" = 'rappel';
