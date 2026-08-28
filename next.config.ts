import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sortie autonome : le conteneur n'embarque que le serveur et les modules
  // reellement traces, au lieu de tout node_modules.
  output: "standalone",
};

export default nextConfig;
