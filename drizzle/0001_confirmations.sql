ALTER TABLE "envois" ADD COLUMN "type" text DEFAULT 'rappel' NOT NULL;--> statement-breakpoint
ALTER TABLE "rappels" ADD COLUMN "jours_silencieux" integer[] DEFAULT '{}' NOT NULL;