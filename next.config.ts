import type { NextConfig } from "next";

/**
 * La sortie autonome n'est activee que pour l'image Docker, via
 * NEXT_SORTIE_AUTONOME=1 pose dans le Dockerfile.
 *
 * Ne surtout pas l'activer inconditionnellement : Vercel fait son propre
 * tracage de fichiers apres le build, et les deux se marchent dessus. Le
 * symptome est une erreur d'empaquetage cote Vercel, alors que le build
 * lui-meme a reussi :
 *
 *   ENOENT: no such file or directory, open '.next/next-server.js.nft.json'
 *
 * Sur Vercel il n'y a rien a configurer : la plateforme sait deja produire le
 * serveur a deployer.
 */
const autonome = process.env.NEXT_SORTIE_AUTONOME === "1";

/**
 * En-tetes de securite. L'app sert des formulaires authentifies et affiche des
 * messages renvoyes par un site tiers (le portail) : ce sont les deux raisons
 * de ne pas s'en passer.
 *
 * script-src et style-src gardent 'unsafe-inline' : Next injecte le script
 * d'hydratation et ses styles en ligne, et s'en affranchir demanderait un
 * middleware posant un nonce par requete. La valeur reste dans le reste de la
 * politique — frame-ancestors interdit l'enchassement, form-action empeche un
 * formulaire injecte de poster ailleurs, default-src coupe toute requete
 * sortante.
 */
const ENTETES = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  // Un an, sous-domaines compris. L'app n'est servie qu'en HTTPS en production.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Les liens de connexion et de desabonnement portent un jeton dans l'URL :
  // aucune raison de laisser une page demander camera, micro ou position.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  ...(autonome ? { output: "standalone" as const } : {}),
  async headers() {
    return [{ source: "/:chemin*", headers: ENTETES }];
  },
};

export default nextConfig;
