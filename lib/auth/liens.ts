import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { liensMagiques, parents } from "../db/schema.ts";
import { expediteur } from "../mail/index.ts";
import { mailLienConnexion } from "../mail/messages.ts";
import { urlPublique } from "../url-publique.ts";

const DUREE_MINUTES = 20;

/**
 * Bornes des demandes de lien. La page de connexion est publique et chaque
 * appel envoie un mail : sans plafond, elle sert de relais d'envoi a qui veut,
 * et le quota Brevo saute avant que quiconque le remarque.
 *
 * Les deux compteurs se lisent sur `liens_magiques`, sans table ni service
 * supplementaire. Un jeton n'a pas de date de creation, mais `expire_le` vaut
 * toujours creation + DUREE_MINUTES : la fenetre s'en deduit.
 *
 * Le plafond par compte borne ce qu'une meme adresse peut recevoir en vingt
 * minutes. Il ne peut pas etre serre : la page de verification ne consomme plus
 * le jeton au chargement, donc un lien non clique reste vivant toute sa duree,
 * et un parent dont le premier mail tombe en indesirables redemande deux ou
 * trois fois de suite. A trois, le quatrieme essai etait refuse alors que la
 * page continue — volontairement, pour ne pas reveler qui est inscrit —
 * d'afficher "un lien vient de vous etre envoye" : le parent attendait un mail
 * qui n'arriverait jamais. Dix laisse passer ce cas tout en bornant l'envoi.
 */
const MAX_JETONS_VIVANTS = 10;
const MAX_PAR_MINUTE = 20;

/** On ne stocke que l'empreinte : la base seule ne permet pas de se connecter. */
const empreinte = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Jetons encore vivants pour ce compte : borne ce qu'une meme adresse peut
 * recevoir. Le refus est silencieux, ici comme plus bas : la page affiche le
 * meme message quoi qu'il arrive, sans quoi la reponse revelerait quelles
 * adresses sont inscrites.
 */
async function jetonsDisponibles(parentId: string): Promise<boolean> {
  const [vivants] = await db
    .select({ n: count() })
    .from(liensMagiques)
    .where(
      and(
        eq(liensMagiques.parentId, parentId),
        gt(liensMagiques.expireLe, new Date()),
        isNull(liensMagiques.utiliseLe),
      ),
    );
  return (vivants?.n ?? 0) < MAX_JETONS_VIVANTS;
}

/**
 * Emis il y a moins d'une minute, toutes adresses confondues : borne le debit
 * global, qu'un attaquant varie ou non les adresses saisies.
 */
async function debitGlobalDisponible(): Promise<boolean> {
  const ilYaUneMinute = new Date(Date.now() + (DUREE_MINUTES - 1) * 60_000);
  const [recents] = await db
    .select({ n: count() })
    .from(liensMagiques)
    .where(gt(liensMagiques.expireLe, ilYaUneMinute));
  return (recents?.n ?? 0) < MAX_PAR_MINUTE;
}

/**
 * Cree le compte si besoin, puis envoie un lien de connexion.
 *
 * Le message est le meme que le compte existe ou non : la reponse de l'app ne
 * doit pas reveler quelles adresses sont inscrites.
 */
export async function envoyerLienMagique(emailBrut: string): Promise<void> {
  const email = emailBrut.trim().toLowerCase();

  // Purge opportuniste : evite d'accumuler des jetons expires sans avoir a
  // planifier un nettoyage dedie.
  await db.delete(liensMagiques).where(lt(liensMagiques.expireLe, new Date()));

  // Les plafonds se verifient AVANT toute ecriture. Creer le compte d'abord
  // laissait un appelant anonyme remplir la table `parents` a volonte — une
  // ligne par requete, sans aucun identifiant, toutes visibles dans /admin —
  // alors meme qu'il etait refuse a l'envoi.
  if (!(await debitGlobalDisponible())) return;

  const [existant] = await db
    .select({ id: parents.id })
    .from(parents)
    .where(eq(parents.email, email));
  if (existant && !(await jetonsDisponibles(existant.id))) return;

  // onConflictDoUpdate malgre la lecture qui precede : deux demandes simultanees
  // sur une adresse inconnue arriveraient sinon toutes deux a l'insertion.
  const parentId =
    existant?.id ??
    (
      await db
        .insert(parents)
        .values({ email })
        .onConflictDoUpdate({ target: parents.email, set: { email } })
        .returning({ id: parents.id })
    )[0].id;

  const token = randomBytes(32).toString("base64url");
  await db.insert(liensMagiques).values({
    tokenHash: empreinte(token),
    parentId,
    expireLe: new Date(Date.now() + DUREE_MINUTES * 60_000),
  });

  // Page de confirmation, et non consommation directe : cf. app/connexion/verifier.
  const lien = `${urlPublique()}/connexion/verifier?token=${token}`;
  const mail = mailLienConnexion({ lien, dureeMinutes: DUREE_MINUTES });
  await expediteur()({
    destinataires: [email],
    objet: mail.objet,
    corps: mail.texte,
    html: mail.html,
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
