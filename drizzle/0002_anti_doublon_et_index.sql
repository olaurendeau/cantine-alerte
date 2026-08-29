ALTER TABLE "envois" DROP CONSTRAINT "envoi_unique";--> statement-breakpoint
CREATE INDEX "liens_magiques_expire_le_idx" ON "liens_magiques" USING btree ("expire_le");--> statement-breakpoint
CREATE INDEX "liens_magiques_parent_id_idx" ON "liens_magiques" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "rappels_jours_avant_idx" ON "rappels" USING gin ("jours_avant");--> statement-breakpoint
ALTER TABLE "envois" ADD CONSTRAINT "envoi_unique" UNIQUE("parent_id","semaine_visee","jours_avant","type");