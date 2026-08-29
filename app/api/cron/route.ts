import { NextResponse } from "next/server";
import { egaliteConstante } from "../../../lib/crypto.ts";
import { executerCron } from "../../../lib/service/verification.ts";
import type { ResultatCron } from "../../../lib/service/verification.ts";

// Le cycle interroge le portail pour chaque famille, avec une pause entre
// chacune pour ne pas declencher le throttling par IP. On prend la marge
// maximale offerte par le plan Hobby.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Vercel envoie "Authorization: Bearer <CRON_SECRET>" quand la variable est
 * definie. Sans ce garde-fou, n'importe qui pourrait declencher un cycle et
 * faire marteler le portail.
 */
function autorise(requete: Request): boolean {
  const attendu = process.env.CRON_SECRET;
  if (!attendu) return false;
  const recu = requete.headers.get("authorization") ?? "";
  return egaliteConstante(recu, `Bearer ${attendu}`);
}

/**
 * `?date=YYYY-MM-DD` simule un autre jour, pour eprouver les rappels en local
 * sans attendre la bonne date.
 *
 * Le garde-fou est un opt-in explicite, et non NODE_ENV : l'image locale est
 * construite en production (c'est tout l'interet de tester l'artefact reel),
 * donc NODE_ENV ne distingue pas le poste du developpeur du vrai deploiement.
 * La variable n'est definie que dans docker-compose.yml ; sur Vercel elle est
 * absente et le parametre est refuse. Il le faut : la date choisit la semaine
 * verifiee, s'en servir en vrai enverrait des rappels pour la mauvaise echeance.
 */
function dateSimulee(requete: Request): Date | undefined {
  const brut = new URL(requete.url).searchParams.get("date");
  if (!brut) return undefined;
  if (process.env.CANTINE_AUTORISER_DATE_SIMULEE !== "1") {
    throw new Error(
      "Le parametre ?date= exige CANTINE_AUTORISER_DATE_SIMULEE=1, reserve au developpement.",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(brut)) {
    throw new Error("?date= attend le format YYYY-MM-DD");
  }
  // Midi heure de Paris : la date simulee ne doit pas basculer d'un jour selon
  // le fuseau du conteneur.
  return new Date(`${brut}T12:00:00+02:00`);
}

/**
 * Resume anonyme d'un cycle : le cadrage, le total, et un decompte par statut.
 * Assez pour savoir d'un coup d'oeil si l'execution s'est bien passee, sans
 * nommer personne.
 */
function resume(resultat: ResultatCron) {
  const parStatut: Record<string, number> = {};
  const inconnus = new Set<string>();
  for (const t of resultat.traites) {
    parStatut[t.statut] = (parStatut[t.statut] ?? 0) + 1;
    for (const code of t.inconnus ?? []) inconnus.add(code);
  }
  return {
    aujourdhui: resultat.aujourdhui,
    echeance: resultat.echeance,
    semaineVisee: resultat.semaineVisee,
    joursRestants: resultat.joursRestants,
    total: resultat.traites.length,
    parStatut,
    // Un code d'etat inconnu du portail doit sauter aux yeux : c'est le seul
    // signal annoncant qu'une regle de classement est a completer.
    ...(inconnus.size ? { etatsNonRepertories: [...inconnus] } : {}),
  };
}

async function executer(requete: Request) {
  if (!autorise(requete)) {
    return NextResponse.json({ erreur: "non autorise" }, { status: 401 });
  }

  let maintenant: Date | undefined;
  try {
    maintenant = dateSimulee(requete);
  } catch (e) {
    return NextResponse.json({ erreur: (e as Error).message }, { status: 400 });
  }

  let resultat: ResultatCron;
  try {
    resultat = await executerCron({
      maintenant,
      trace: (...a) => console.log("[cron]", ...a),
    });
  } catch (e) {
    // Le cycle isole deja chaque famille ; arriver ici veut dire que c'est le
    // cadre lui-meme qui a lache (base injoignable, secret manquant).
    //
    // Le motif reste dans les logs Vercel, qui sont prives : ces pannes-la sont
    // precisement celles dont le message expose la cible de connexion — hote,
    // port, base, parfois l'utilisateur — ou des valeurs de ligne recopiees par
    // le pilote. Le filet GitHub Actions imprime la reponse telle quelle dans
    // des journaux publics, au meme titre que le resume ci-dessous.
    console.error("[cron] cycle interrompu :", (e as Error).message);
    return NextResponse.json({ erreur: "cycle interrompu" }, { status: 500 });
  }

  // Le detail nominatif reste dans les logs Vercel, qui sont prives.
  console.log("[cron]", JSON.stringify(resultat));
  // La reponse, elle, est agregee : elle transite par le filet GitHub Actions,
  // dont les logs sont publics puisque le depot l'est. Y laisser les adresses
  // des familles publierait la liste des inscrits.
  return NextResponse.json(resume(resultat));
}

export const GET = executer;
export const POST = executer;
