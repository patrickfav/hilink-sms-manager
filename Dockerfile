FROM node:26-alpine AS frontend
WORKDIR /src
RUN npm install --global pnpm@12.5.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile
COPY frontend frontend
COPY vite.config.ts tsconfig.json ./
RUN pnpm build:frontend

FROM golang:1.27.4-alpine AS backend
WORKDIR /src/backend
COPY backend/go.mod ./
RUN go mod download
COPY backend ./
COPY --from=frontend /src/backend/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/hilink-sms ./cmd/server

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=backend /out/hilink-sms /hilink-sms
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/hilink-sms"]
