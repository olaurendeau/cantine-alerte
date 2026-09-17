"use client";

import { useState } from "react";
import { libelleJourSemaine } from "../../lib/portail/dates.ts";

const modifier = (ensemble: Set<number>, n: number, actif: boolean): Set<number> => {
  const suivant = new Set(ensemble);
  if (actif) suivant.add(n);
  else suivant.delete(n);
  return suivant;
};

const COLONNES = [
  { nom: "cantine", entete: "Cantine" },
  { nom: "matin", entete: "Périscolaire matin" },
  { nom: "soir", entete: "Périscolaire soir" },
] as const;

/**
 * La grille jours x prestations.
 *
 * Composant client pour la meme raison que LignesRappel : l'etat coche doit
 * suivre l'utilisateur pour que le message d'aide sous le tableau reste vrai.
 * Le stockage reste asymetrique cote base — la cantine en negatif
 * (`jours_sans_cantine`), le periscolaire en positif — pour que la liste vide,
 * donc le defaut, vaille le comportement sur de chaque cote. C'est l'affichage
 * seul qui uniformise en positif : cocher est ce que fait le parent.
 */
export function GrilleSurveillance({
  joursPossibles,
  cantine,
  matin,
  soir,
}: {
  joursPossibles: number[];
  cantine: number[];
  matin: number[];
  soir: number[];
}) {
  const [coches, setCoches] = useState(() => ({
    cantine: new Set(cantine),
    matin: new Set(matin),
    soir: new Set(soir),
  }));

  const basculer = (nom: "cantine" | "matin" | "soir", n: number, actif: boolean) =>
    setCoches((p) => ({ ...p, [nom]: modifier(p[nom], n, actif) }));

  return (
    <>
      <div className="tableau">
        <table>
          <thead>
            <tr>
              <th>Jour</th>
              {COLONNES.map((c) => (
                <th key={c.nom}>{c.entete}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {joursPossibles.map((n) => (
              <tr key={n}>
                <td>{libelleJourSemaine(n)}</td>
                {COLONNES.map((c) => (
                  <td key={c.nom}>
                    <input
                      type="checkbox"
                      name={c.nom}
                      value={n}
                      aria-label={`${c.entete} le ${libelleJourSemaine(n)}`}
                      checked={coches[c.nom].has(n)}
                      onChange={(e) => basculer(c.nom, n, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {coches.cantine.size === 0 && (
        <p className="doux">
          Aucun jour de cantine coché : vous ne serez plus prévenu d&apos;un repas oublié.
        </p>
      )}
    </>
  );
}
