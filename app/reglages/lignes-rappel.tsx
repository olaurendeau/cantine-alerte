"use client";

import { useState } from "react";
import { libelleJourAvant } from "../../lib/portail/dates.ts";

const modifier = (ensemble: Set<number>, n: number, actif: boolean): Set<number> => {
  const suivant = new Set(ensemble);
  if (actif) suivant.add(n);
  else suivant.delete(n);
  return suivant;
};

/**
 * Les lignes de la table des rappels.
 *
 * Composant client pour une seule raison : la seconde case n'a de sens que si
 * la premiere est cochee. Rendues independantes, elles affichaient « meme si
 * tout est reserve » coche sur des jours ou aucun rappel n'etait demande —
 * l'ecran promettait un message pour un jour ou l'on ne previent de rien. Le
 * stockage reste en negatif cote base (`joursSilencieux`), pour qu'une liste
 * vide vaille « confirmer partout » ; c'est l'affichage seul qui suit ici.
 */
export function LignesRappel({
  joursPossibles,
  joursAvant,
  joursSilencieux,
}: {
  joursPossibles: number[];
  joursAvant: number[];
  joursSilencieux: number[];
}) {
  const [jours, setJours] = useState(() => new Set(joursAvant));
  // Confirmations restreintes aux jours retenus : c'est ce qui evite de partir
  // d'un etat ou la seconde colonne contredit la premiere.
  const [confirmations, setConfirmations] = useState(
    () => new Set(joursAvant.filter((n) => !joursSilencieux.includes(n))),
  );

  return (
    <>
      {joursPossibles.map((n) => {
        const prevenu = jours.has(n);
        const jour = libelleJourAvant(n);
        return (
          <tr key={n}>
            <td>{jour}</td>
            <td>
              <input
                type="checkbox"
                name="jours"
                value={n}
                aria-label={`Me prévenir ${jour}`}
                checked={prevenu}
                onChange={(e) => {
                  const actif = e.target.checked;
                  setJours((p) => modifier(p, n, actif));
                  // Activer un rappel active sa confirmation : c'est le defaut
                  // du service, et l'oublier priverait le parent du message qui
                  // lui dit que la surveillance tourne.
                  if (actif) setConfirmations((p) => modifier(p, n, true));
                }}
              />
            </td>
            <td>
              <input
                type="checkbox"
                name="confirmation"
                value={n}
                aria-label={`Confirmer ${jour} même si tout est réservé`}
                // Desactivee tant que le rappel ne l'est pas : une case grisee
                // dit d'elle-meme qu'elle ne s'applique pas, la ou une phrase
                // sous le tableau demandait au lecteur de le deduire.
                checked={prevenu && confirmations.has(n)}
                disabled={!prevenu}
                onChange={(e) => setConfirmations((p) => modifier(p, n, e.target.checked))}
              />
            </td>
          </tr>
        );
      })}
    </>
  );
}
