#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH=${1:-amd64}
case "$ARCH" in amd64|arm64) ;; *) echo 'Usage: bash ops/build.sh [amd64|arm64]' >&2; exit 2;; esac
BUILD_VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo dev)
mkdir -p dist
CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -ldflags="-s -w -X main.version=$BUILD_VERSION" -o "dist/scf-tunnel-linux-$ARCH" .
printf 'Built dist/scf-tunnel-linux-%s (%s)\n' "$ARCH" "$BUILD_VERSION"
