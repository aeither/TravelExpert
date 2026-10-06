FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package*.json ./
RUN npm ci
COPY agent ./agent
COPY scripts ./scripts
RUN npx eve build
CMD ["node", "scripts/railway-start.mjs"]
