import { desc, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { sessionCourante } from "../../lib/auth/session.ts";
import { db } from "../../lib/db/index.ts";
import { destinataires, identifiantsPortail, parents, rappels } from "../../lib/db/schema.ts";
import { libelleJourAvant } from "../../lib/portail/dates.ts";
import { estAdmin } from "../../lib/service/verification.ts";

/**
 * Vue d'exploitation : qui est inscrit, qui est en panne. Volontairement en
 * lecture seule, et ne selectionne jamais `mdp_chiffre` ni `portail_email` :
 * l'administrateur n'a aucun besoin des identifiants des familles, donc il ne
 * doit pas pouvoir les voir, meme chiffres.
 */
export default async function Admin() {
  const session = await sessionCourante();
  if (!session) redirect("/connexion");
  if (!estAdmin(session.email)) redirect("/reglages");

  const comptes = await db
    .select({
      email: parents.email,
      actif: parents.actif,
      creeLe: parents.creeLe,
      verifieLe: identifiantsPortail.verifieLe,
      echecs: identifiantsPortail.echecsConsecutifs,
      derniereErreur: identifiantsPortail.derniereErreur,
      joursAvant: rappels.joursAvant,
      nbDestinataires: sql<number>`(
        select count(*) from ${destinataires} where ${destinataires.parentId} = ${parents.id}
      )`,
    })
    .from(parents)
    .leftJoin(identifiantsPortail, eq(identifiantsPortail.parentId, parents.id))
    .leftJoin(rappels, eq(rappels.parentId, parents.id))
    .orderBy(desc(parents.creeLe));

  const enPanne = comptes.filter((c) => (c.echecs ?? 0) > 0);
  const dateFr = (d: Date | null) =>
    d ? d.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }) : "—";

  return (
    <>
      <h1>Administration</h1>
      <p className="doux">
        {comptes.length} compte(s), {comptes.filter((c) => c.actif).length} actif(s),{" "}
        {enPanne.length} en erreur. <a href="/reglages">Retour aux reglages</a>
      </p>

      <div className="message">
        Cette page ne donne acces a aucun identifiant de famille : ni les mots de passe, ni meme les
        identifiants du portail n&apos;y sont charges.
      </div>

      <div className="carte">
        <div className="tableau">
          <table>
            <thead>
              <tr>
                <th>Compte</th>
                <th>Etat</th>
                <th>Derniere verif.</th>
                <th>Rappels</th>
                <th>Dest.</th>
                <th>Erreur</th>
              </tr>
            </thead>
            <tbody>
              {comptes.map((c) => (
                <tr key={c.email}>
                  <td>{c.email}</td>
                  <td>{c.actif ? "actif" : "suspendu"}</td>
                  <td>{dateFr(c.verifieLe)}</td>
                  <td>{(c.joursAvant ?? []).map(libelleJourAvant).join(", ") || "—"}</td>
                  <td>{c.nbDestinataires}</td>
                  <td>
                    {c.echecs ? `${c.echecs}x — ${c.derniereErreur ?? ""}`.slice(0, 90) : "—"}
                  </td>
                </tr>
              ))}
              {comptes.length === 0 && (
                <tr>
                  <td colSpan={6} className="doux">
                    Aucun compte inscrit.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
