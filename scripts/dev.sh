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

exec pnpm exec concurrently -k -n mock,backend,frontend -c yellow,blue,green \
  "pnpm dev:mock" \
  "pnpm dev:backend" \
  "pnpm dev:frontend"
