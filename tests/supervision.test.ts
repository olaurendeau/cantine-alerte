import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nettoyerEvenement,
  sansAdresses,
  sansEnTetesSensibles,
  urlSansSecrets,
} from "../lib/supervision/anonymiser.ts";
import { aIgnorer, natureDe } from "../lib/supervision/filtres.ts";

test("une URL perd sa query string, donc ses jetons", () => {
  // C'est le cas qui justifie tout le module : ces jetons sont vifs, et celui
  // de connexion ouvre la session du parent.
  assert.equal(
    urlSansSecrets("https://app.fr/connexion/verifier?token=rFDocWNaihDqU4YMUyQJ"),
    "https://app.fr/connexion/verifier",
  );
  assert.equal(urlSansSecrets("https://app.fr/pause?jeton=abc&semaine=2026-09-28"), "https://app.fr/pause");
  assert.equal(urlSansSecrets("https://app.fr/reglages#bas"), "https://app.fr/reglages");
});

test("une URL sans query string est rendue telle quelle", () => {
  assert.equal(urlSansSecrets("https://app.fr/reglages"), "https://app.fr/reglages");
  assert.equal(urlSansSecrets(""), "");
});

test("les adresses sont masquees sans rendre le message illisible", () => {
  // Les motifs d'erreur viennent du portail et de Brevo, qui citent l'adresse.
  assert.equal(
    sansAdresses("Mauvais email et/ou mot de passe pour parent@exemple.fr."),
    "Mauvais email et/ou mot de passe pour [adresse].",
  );
  assert.equal(
    sansAdresses("refus sur marie.durand+cantine@exemple.co.uk et paul@exemple.fr"),
    "refus sur [adresse] et [adresse]",
  );
  assert.equal(sansAdresses("502 sur /api/login"), "502 sur /api/login");
});

test("les en-tetes porteurs de secrets sont retires", () => {
  // `authorization` porte le CRON_SECRET, `cookie` la session signee.
  assert.deepEqual(
    sansEnTetesSensibles({
      authorization: "Bearer s3cr3t",
      Cookie: "session=abc",
      "set-cookie": "session=abc",
      "user-agent": "Mozilla/5.0",
      "content-type": "application/json",
    }),
    { "user-agent": "Mozilla/5.0", "content-type": "application/json" },
  );
});

test("un evenement complet ressort sans jeton, sans adresse et sans corps", () => {
  const nettoye = nettoyerEvenement({
    request: {
      url: "https://app.fr/connexion/verifier?token=vif",
      query_string: "token=vif",
      // Le POST des reglages porte l'identifiant portail ET le mot de passe.
      data: { portailEmail: "parent@exemple.fr", motDePasse: "secret" },
      headers: { authorization: "Bearer s3cr3t", "user-agent": "Mozilla/5.0" },
      cookies: { session: "abc" },
    },
    message: "echec pour parent@exemple.fr",
    breadcrumbs: [
      { message: "envoi a parent@exemple.fr", data: { url: "https://api.brevo.com/v3?k=1" } },
    ],
    exception: { values: [{ value: "adresse refusee : parent@exemple.fr" }] },
    user: { id: "52067c06-11e3-4e94-bf6d-53ca1bcccd8c", email: "parent@exemple.fr", ip_address: "82.1.2.3" },
  });

  assert.equal(nettoye.request?.url, "https://app.fr/connexion/verifier");
  assert.equal(nettoye.request?.query_string, undefined);
  assert.equal(nettoye.request?.data, undefined);
  assert.equal(nettoye.request?.cookies, undefined);
  assert.deepEqual(nettoye.request?.headers, { "user-agent": "Mozilla/5.0" });
  assert.equal(nettoye.message, "echec pour [adresse]");
  assert.equal(nettoye.breadcrumbs?.[0]?.message, "envoi a [adresse]");
  assert.equal(nettoye.breadcrumbs?.[0]?.data?.url, "https://api.brevo.com/v3");
  assert.equal(nettoye.exception?.values?.[0]?.value, "adresse refusee : [adresse]");
  // Seul l'identifiant pseudonyme survit : ni adresse, ni IP.
  assert.deepEqual(nettoye.user, { id: "52067c06-11e3-4e94-bf6d-53ca1bcccd8c" });
});

test("un evenement sans utilisateur identifie n'en invente pas", () => {
  const nettoye = nettoyerEvenement({ user: { ip_address: "82.1.2.3" } });
  assert.equal(nettoye.user, undefined);
});

test("un evenement vide traverse sans lever", () => {
  // `beforeSend` recoit aussi des evenements minimaux : un plantage ici ferait
  // perdre l'evenement qu'on cherchait justement a voir.
  assert.deepEqual(nettoyerEvenement({}), {});
});

test("les evenements normaux du service ne remontent pas en alerte", () => {
  // Un mot de passe portail change : le service desactive le compte et ecrit au
  // parent. Alerter ici, c'est une notification par famille distraite — et on
  // apprend a ne plus les lire.
  const identifiants = new Error("Mauvais email et/ou mot de passe.");
  identifiants.name = "ErreurIdentifiants";
  assert.equal(aIgnorer(identifiants), true);

  // Throttling par IP : deja evite par construction, insister est exactement ce
  // qu'il ne faut pas faire.
  const throttle = Object.assign(new Error("429"), { name: "ErreurTemporaire", statut: 429 });
  assert.equal(aIgnorer(throttle), true);
});

test("une vraie panne passe le filtre", () => {
  // 5xx : le portail est en panne, si ca dure les rappels tombent.
  const panne = Object.assign(new Error("502"), { name: "ErreurTemporaire", statut: 502 });
  assert.equal(aIgnorer(panne), false);

  // Changement de HTML : le parsing est casse et le service se tait. C'est LA
  // panne a attraper.
  const structure = new Error("champ cache absent");
  structure.name = "ErreurStructure";
  assert.equal(aIgnorer(structure), false);

  assert.equal(aIgnorer(new Error("boum")), false);
  assert.equal(aIgnorer("pas une erreur"), false);
});

test("la nature distingue ce que le statut confond", () => {
  // `echec_technique` recouvre structure ET temporaire : sans cette nature, on
  // ne saurait pas s'il faut reprendre le parsing ou attendre.
  const structure = new Error("JSON illisible");
  structure.name = "ErreurStructure";
  assert.equal(natureDe(structure), "structure");

  const temporaire = Object.assign(new Error("503"), { name: "ErreurTemporaire", statut: 503 });
  assert.equal(natureDe(temporaire), "temporaire");

  const identifiants = new Error("refus");
  identifiants.name = "ErreurIdentifiants";
  assert.equal(natureDe(identifiants), "identifiants");

  assert.equal(natureDe(new Error("boum")), "inconnue");
  assert.equal(natureDe(undefined), "inconnue");
});

test("les contextes nommes sont nettoyes comme le reste", () => {
  // Seul champ libre que rien ne filtrait, et c'est precisement la que les
  // signaux du cycle deposent un motif d'erreur brut.
  const nettoye = nettoyerEvenement({
    contexts: {
      cycle: {
        exemple: "adresse refusee : parent@exemple.fr",
        parentIds: ["52067c06-11e3-4e94-bf6d-53ca1bcccd8c"],
        familles: 1,
        imbrique: { motif: "doublon sur paul@exemple.fr" },
      },
    },
  });
  const c = nettoye.contexts?.cycle as Record<string, unknown>;
  assert.equal(c.exemple, "adresse refusee : [adresse]");
  assert.deepEqual(c.imbrique, { motif: "doublon sur [adresse]" });
  // Les valeurs non textuelles traversent intactes.
  assert.equal(c.familles, 1);
  assert.deepEqual(c.parentIds, ["52067c06-11e3-4e94-bf6d-53ca1bcccd8c"]);
});
