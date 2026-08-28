import { urlPortail } from "./auth.ts";
import { formaterJour } from "./dates.ts";
import type { Cible, ConfigPortail } from "./types.ts";

export type Notification = {
  urgent: boolean;
  objet: string;
  corps: string;
};

/**
 * Compose la notification. Aucune I/O ici : la fonction est pure, ce qui la
 * rend testable et permet de la brancher indifferemment sur la console ou sur
 * un mail.
 */
export function composerNotification(
  cfg: Pick<ConfigPortail, "portail">,
  {
    manquants,
    semaine,
    echeance,
    joursRestants,
    urgent,
  }: {
    manquants: Cible[];
    semaine: Date;
    echeance: Date;
    joursRestants: number;
    urgent: boolean;
  },
): Notification {
  const delai =
    joursRestants === 0
      ? "ce soir avant minuit"
      : `avant ${formaterJour(echeance)} minuit, dans ${joursRestants} jour${joursRestants > 1 ? "s" : ""}`;

  // Un jour, plusieurs enfants : on regroupe pour ne pas repeter la date.
  const parJour = new Map<string, string[]>();
  for (const m of manquants) {
    const cle = formaterJour(m.date);
    if (!parJour.has(cle)) parJour.set(cle, []);
    parJour.get(cle)!.push(m.enfant);
  }

  return {
    urgent,
    objet: urgent
      ? "Cantine : dernier jour pour reserver"
      : `Cantine : ${manquants.length} repas non reserves`,
    corps: [
      `Semaine du ${formaterJour(semaine)}, a reserver ${delai} :`,
      ...[...parJour].map(([jour, qui]) => `- ${jour} : ${qui.join(", ")}`),
      "",
      `Reserver : ${urlPortail(cfg)}`,
    ].join("\n"),
  };
}

/**
 * Message de confirmation quand rien ne manque.
 *
 * Sans lui, l'absence de mail est ambigue : le parent ne peut pas distinguer
 * "tout est reserve" d'un service en panne. Un mot rassurant leve le doute, et
 * reste desactivable jour par jour pour ceux que ca encombre.
 */
export function composerConfirmation(
  cfg: Pick<ConfigPortail, "portail">,
  {
    semaine,
    echeance,
    joursRestants,
    reserves,
  }: { semaine: Date; echeance: Date; joursRestants: number; reserves: number },
): Notification {
  const quand =
    joursRestants === 0
      ? "l'echeance est ce soir a minuit"
      : `l'echeance est ${formaterJour(echeance)} a minuit`;
  return {
    urgent: false,
    objet: `Cantine : tout est reserve pour la semaine du ${formaterJour(semaine)}`,
    corps: [
      `Rien a faire : les ${reserves} repas de la semaine du ${formaterJour(semaine)} sont reserves.`,
      `Pour information, ${quand}.`,
      "",
      `Verifier par vous-meme : ${urlPortail(cfg)}`,
    ].join("\n"),
  };
}

/** Rendu console, encadre pour etre lisible d'un coup. */
export function formaterConsole(notif: Notification): string {
  const barre = "=".repeat(64);
  return [
    barre,
    `${notif.urgent ? "[URGENT] " : ""}${notif.objet}`,
    "-".repeat(64),
    notif.corps,
    barre,
  ].join("\n");
}
