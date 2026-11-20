# One build, several runtime targets: api, worker, web, mailstub, migrate.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate || npm i -g pnpm@12.6.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY infra/mailstub ./infra/mailstub
COPY .env.example ./.env
RUN pnpm install --frozen-lockfile && pnpm build

FROM build AS api
ENV NODE_ENV=production
WORKDIR /repo/apps/api
EXPOSE 3001
CMD ["node", "dist/main.js"]

FROM build AS migrate
ENV NODE_ENV=production
WORKDIR /repo/apps/api
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/seed/main.js"]

FROM build AS worker
ENV NODE_ENV=production
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]

FROM build AS mailstub
ENV NODE_ENV=production
WORKDIR /repo/infra/mailstub
EXPOSE 1025 8025
CMD ["node", "dist/main.js"]

FROM build AS web
ENV NODE_ENV=production
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["pnpm", "exec", "next", "start", "-p", "3000"]
