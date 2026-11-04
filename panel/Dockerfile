FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz');process.exit(r.ok?0:1)"
CMD ["bun", "src/server.ts"]
