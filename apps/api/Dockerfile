# API image (NestJS). Build from the repository root: docker build -f apps/api/Dockerfile .
# The same image runs the API and, with another command, the one-off migration and seed (docker-compose.prod.yml).
FROM node:22-bookworm-slim AS build
# The version in package.json (packageManager); corepack cannot fetch it offline
RUN npm install -g pnpm@12.8.1
WORKDIR /app

# Dependencies first: this layer is reused until a package.json or the lockfile changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@iso-dms/api..."

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# The Prisma client is generated into src/generated, which the build then compiles
RUN pnpm --filter @iso-dms/api prisma:generate && pnpm --filter @iso-dms/api build

FROM node:22-bookworm-slim
RUN npm install -g pnpm@12.8.1
ENV NODE_ENV=production
WORKDIR /app
# Everything is copied as it is (pnpm's links are relative): prisma and tsx stay, the migration and seed need them
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/main.js"]
