import * as Sentry from "@sentry/nextjs";
import { signauxDe } from "../../../lib/supervision/signaux.ts";
import type { ResultatCron } from "../../../lib/service/verification.ts";

/**
 * L'envoi des signaux du cycle vers Sentry.
 *
 * ⚠️ Ce fichier est dans `app/` et non dans `lib/`, volontairement : il importe
 * le SDK Sentry, qui est du code de plateforme. `scripts/cron.ts` execute le
 * meme cycle sous Node nu et tirerait le SDK Next avec lui. La regle du projet
 * — « `lib/portail` ignore tout de la base et du web » — vaut ici aussi.
 *
 * Il ne decide de rien : le tri est dans `lib/supervision/signaux.ts`, pur et
 * teste. Ce module ne fait que poster.
 *
 * Tout est defensif. Une supervision qui leve ferait perdre le rappel qu'elle
 * observe, soit exactement l'inverse de son objet.
 */

/**
 * Le moniteur de tache planifiee, cote Sentry.
 *
 * C'est la seule piece capable de detecter une execution qui **n'a pas eu
 * lieu** : Sentry constate l'absence de check-in dans la fenetre, sans rien
 * executer chez nous. Un cron mort ne laisse aucune trace dans les journaux —
 * il n'y a pas eu de journal.
 */
const MONITEUR = "rappel-cantine";

const CONFIG_MONITEUR = {
  schedule: { type: "crontab" as const, value: "0 16 * * *" },
  /**
   * Une heure de battement : le plan Hobby declenche la tache a +/- 59 minutes
   * de l'heure visee. Plus serre, l'alarme sonnerait les jours ou Vercel part
   * simplement en retard.
   */
  checkinMargin: 60,
  /** `maxDuration` vaut 300 s, et le cycle s'arrete de lui-meme a 230 s. */
  maxRuntime: 6,
  /** Les crons Vercel sont exprimes en UTC. */
  timezone: "Etc/UTC",
};

/** Ne jamais laisser la supervision interrompre le cycle qu'elle observe. */
function sansLever(action: () => void): void {
  try {
    action();
  } catch (e) {
    console.error("[cron] supervision indisponible :", (e as Error).message);
  }
}

export function demarrerCheckIn(): string | undefined {
  let id: string | undefined;
  sansLever(() => {
    id = Sentry.captureCheckIn({ monitorSlug: MONITEUR, status: "in_progress" }, CONFIG_MONITEUR);
  });
  return id;
}

export function terminerCheckIn(checkInId: string | undefined, statut: "ok" | "error"): void {
  if (!checkInId) return;
  sansLever(() => {
    Sentry.captureCheckIn({ checkInId, monitorSlug: MONITEUR, status: statut }, CONFIG_MONITEUR);
  });
}

/**
 * Les signaux d'un cycle termine.
 *
 * L'empreinte fixe est la cle du dispositif : sans elle, deux libelles
 * legerement differents ouvriraient deux issues, et la boite grossirait
 * jusqu'a ce qu'on cesse de la lire.
 */
export function signalerCycle(resultat: ResultatCron): void {
  for (const signal of signauxDe(resultat)) {
    sansLever(() => {
      Sentry.withScope((portee) => {
        portee.setLevel(signal.niveau);
        portee.setFingerprint([signal.empreinte]);
        portee.setTag("signal", signal.empreinte);
        portee.setContext("cycle", signal.contexte);
        Sentry.captureMessage(signal.message);
      });
    });
  }
}

/**
 * La panne du cadre lui-meme : base injoignable, secret manquant.
 *
 * Le cycle isole deja chaque famille ; arriver ici veut dire que plus personne
 * ne sera examine aujourd'hui.
 */
export function signalerCycleInterrompu(erreur: unknown): void {
  sansLever(() => {
    Sentry.withScope((portee) => {
      portee.setLevel("error");
      portee.setTag("signal", "cycle-interrompu");
      Sentry.captureException(erreur);
    });
  });
}

/**
 * ⚠️ A appeler avant de rendre la reponse.
 *
 * Une fonction serverless est gelee des qu'elle a repondu : sans ce vidage,
 * les evenements encore en file partent a la poubelle, et la supervision se
 * tait precisement les jours ou elle aurait servi.
 */
export async function vider(): Promise<void> {
  try {
    await Sentry.flush(2000);
  } catch {
    // Un envoi Sentry rate ne doit jamais teindre en echec un cycle reussi.
  }
}
