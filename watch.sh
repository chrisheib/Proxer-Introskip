#!/usr/bin/env sh
set -eu

if ! command -v esbuild >/dev/null 2>&1; then
  echo "Error: esbuild executable not found in PATH." >&2
  echo "Install standalone esbuild binary and retry." >&2
  exit 1
fi

mkdir -p dist

esbuild $(find src -name '*.ts' ! -name '*.d.ts') \
  --outdir=dist \
  --target=es2020 \
  --format=iife \
  --sourcemap \
  --watch
