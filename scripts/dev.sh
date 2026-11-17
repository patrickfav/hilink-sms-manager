#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

if [ ! -f .env.dev ]; then
  cp .env.dev.example .env.dev
  echo "Created .env.dev with local mock defaults."
fi

set -a
. ./.env.dev
set +a

# The Go server embeds backend/web/dist at compile time. Rebuild when the
# embedded HTML or any asset it references is missing; Vite still serves the
# live frontend with hot reload during development.
needs_frontend_build=false
if [ ! -f backend/web/dist/index.html ]; then
  needs_frontend_build=true
else
  for asset in $(sed -nE 's/.*(src|href)="\/([^"]+)".*/\2/p' backend/web/dist/index.html); do
    if [ ! -f "backend/web/dist/$asset" ]; then
      needs_frontend_build=true
      break
    fi
  done
fi
if [ "$needs_frontend_build" = true ]; then
  echo "Building embedded frontend assets for the backend."
  pnpm build:frontend
fi

exec pnpm exec concurrently -k -n mock,backend,frontend -c yellow,blue,green \
  "pnpm dev:mock" \
  "pnpm dev:backend" \
  "pnpm dev:frontend"
