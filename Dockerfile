FROM oven/bun:1-alpine

# Security: run as non-root user
RUN addgroup -S moments && adduser -S moments -G moments

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

COPY src/ ./src/

# Drop all capabilities — this container only needs outbound HTTPS
# (to Slack, GitHub, OpenRouter APIs)
USER moments

# No exposed ports needed — Socket Mode uses outbound WebSocket
ENV NODE_ENV=production
ENV TZ=Europe/Amsterdam

CMD ["bun", "run", "src/index.ts"]
