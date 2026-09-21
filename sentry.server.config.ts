/**
 * SDK Sentry, runtime Node — celui qui compte.
 *
 * C'est ici que tourne le cycle de rappel : les pannes qui coutent un repas
 * sont toutes de ce cote. Charge par `register()` dans `instrumentation.ts`.
 */
import * as Sentry from "@sentry/nextjs";
import { optionsCommunes } from "./lib/supervision/options.ts";

Sentry.init(optionsCommunes());
