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

# The Go server embeds backend/web/dist at compile time. Build it once for a
# clean checkout before Air starts; Vite still serves the live frontend with
# hot reload during development.
if [ ! -f backend/web/dist/index.html ]; then
  echo "Building embedded frontend assets for the backend."
  pnpm build:frontend
fi

exec pnpm exec concurrently -k -n mock,backend,frontend -c yellow,blue,green \
  "pnpm dev:mock" \
  "pnpm dev:backend" \
  "pnpm dev:frontend"
