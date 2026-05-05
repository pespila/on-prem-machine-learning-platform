FROM node:20-slim AS dev
WORKDIR /app
RUN corepack enable
COPY .npmrc* package.json pnpm-lock.yaml* ./
RUN pnpm install
COPY . .
EXPOSE 80
CMD ["pnpm", "dev", "--host", "0.0.0.0", "--port", "80"]


FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY .npmrc* package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build


FROM nginx:1.27-alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
