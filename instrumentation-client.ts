/**
 * SDK Sentry, navigateur (convention Next).
 *
 * ⚠️ Les evenements ne partent pas directement chez Sentry : `tunnelRoute`
 * (cf. `next.config.ts`) les fait transiter par notre propre origine, ce qui
 * laisse la CSP en `connect-src 'self'`.
 */
import * as Sentry from "@sentry/nextjs";
import { optionsCommunes } from "./lib/supervision/options.ts";

Sentry.init(optionsCommunes());

/**
 * Les navigations de l'App Router, pour que la trace d'une erreur dise d'ou
 * venait le parent. Les URL sont lavees de leur query string par
 * `beforeBreadcrumb` — celles du projet portent des jetons.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
