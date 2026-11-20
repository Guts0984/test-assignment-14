# One image for every service (api, worker, web, mailstub, migrate): the monorepo is built once, and each compose service
# only picks a working directory and a command. One build and one image export instead of one per service.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate || npm i -g pnpm@12.6.0
WORKDIR /repo
# Dependencies are downloaded from the lockfile alone, so this layer (the slow one) is reused until the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY infra/mailstub ./infra/mailstub
COPY .env.example ./.env
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --offline
RUN pnpm build && rm -rf /root/.cache
ENV NODE_ENV=production
