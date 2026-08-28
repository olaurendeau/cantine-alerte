# syntax=docker/dockerfile:1

# Node 24 : le TypeScript des scripts est execute nativement, sans transpilation.
ARG NODE=node:24-alpine

# ---------------------------------------------------------------------------
# Dependances
# ---------------------------------------------------------------------------
FROM ${NODE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# Outils : node_modules complet + sources. Sert aux migrations, au seed et au
# CLI de diagnostic, qui ont besoin de drizzle-kit et des scripts, absents de
# la sortie autonome.
# ---------------------------------------------------------------------------
FROM ${NODE} AS outils
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npm", "run", "db:migrer"]

# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------
FROM ${NODE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Aucune variable d'environnement n'est necessaire ici : la connexion a la base
# est differee au premier acces, justement pour que l'image se construise sans
# base disponible.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------
FROM ${NODE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Utilisateur non privilegie : le serveur n'a aucune raison d'etre root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/confidentialite').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
