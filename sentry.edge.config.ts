/**
 * SDK Sentry, runtime Edge.
 *
 * Aucune route du projet ne tourne en edge aujourd'hui. Le fichier existe
 * quand meme : Next charge ce runtime de lui-meme pour certaines parties, et
 * l'oublier donnerait un angle mort silencieux le jour ou ca changerait.
 */
import * as Sentry from "@sentry/nextjs";
import { optionsCommunes } from "./lib/supervision/options.ts";

Sentry.init(optionsCommunes());
