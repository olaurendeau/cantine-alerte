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

const nextConfig: NextConfig = {
  ...(autonome ? { output: "standalone" as const } : {}),
};

export default nextConfig;
