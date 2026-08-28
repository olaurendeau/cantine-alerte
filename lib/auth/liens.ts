import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { liensMagiques, parents } from "../db/schema.ts";
import { expediteur } from "../mail/index.ts";

const DUREE_MINUTES = 20;

/** On ne stocke que l'empreinte : la base seule ne permet pas de se connecter. */
const empreinte = (token: string) => createHash("sha256").update(token).digest("hex");

const appUrl = () => process.env.APP_URL ?? "http://localhost:3000";

/**
 * Cree le compte si besoin, puis envoie un lien de connexion.
 *
 * Le message est le meme que le compte existe ou non : la reponse de l'app ne
 * doit pas reveler quelles adresses sont inscrites.
 */
export async function envoyerLienMagique(emailBrut: string): Promise<void> {
  const email = emailBrut.trim().toLowerCase();

  const [parent] = await db
    .insert(parents)
    .values({ email })
    .onConflictDoUpdate({ target: parents.email, set: { email } })
    .returning({ id: parents.id });

  // Purge opportuniste : evite d'accumuler des jetons expires sans avoir a
  // planifier un nettoyage dedie.
  await db.delete(liensMagiques).where(lt(liensMagiques.expireLe, new Date()));

  const token = randomBytes(32).toString("base64url");
  await db.insert(liensMagiques).values({
    tokenHash: empreinte(token),
    parentId: parent.id,
    expireLe: new Date(Date.now() + DUREE_MINUTES * 60_000),
  });

  const lien = `${appUrl()}/api/auth/verifier?token=${token}`;
  await expediteur()({
    destinataires: [email],
    objet: "Votre lien de connexion — Alerte cantine",
    corps: [
      "Voici votre lien de connexion :",
      "",
      lien,
      "",
      `Il expire dans ${DUREE_MINUTES} minutes et ne fonctionne qu'une fois.`,
      "Si vous n'etes pas a l'origine de cette demande, ignorez ce message.",
    ].join("\n"),
  });
}

export type Verification = { parentId: string; email: string } | null;

/** Consomme un jeton. Retourne null s'il est inconnu, expire ou deja utilise. */
export async function consommerLien(token: string): Promise<Verification> {
  const [ligne] = await db
    .update(liensMagiques)
    .set({ utiliseLe: new Date() })
    .where(
      and(
        eq(liensMagiques.tokenHash, empreinte(token)),
        gt(liensMagiques.expireLe, new Date()),
        isNull(liensMagiques.utiliseLe),
      ),
    )
    .returning({ parentId: liensMagiques.parentId });

  if (!ligne) return null;

  const [parent] = await db
    .select({ id: parents.id, email: parents.email })
    .from(parents)
    .where(eq(parents.id, ligne.parentId));

  return parent ? { parentId: parent.id, email: parent.email } : null;
}
