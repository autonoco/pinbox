#!/bin/sh
# pinbox installer — the secondary distribution channel.
#
# The npm launcher is the primary channel, but its shim has a `#!/usr/bin/env node` shebang,
# so it needs *some* JS runtime to spin up. This script is for machines that have none —
# including Bun-only boxes, where node is exactly what is missing. It downloads one compiled
# binary (Bun is embedded in it; nothing else is required), verifies its checksum, and drops
# it on PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/autonoco/pinbox/main/tools/release/install.sh | sh
#
# Env: PINBOX_INSTALL_DIR (default $HOME/.local/bin), PINBOX_VERSION (default latest).
set -eu

REPO="autonoco/pinbox"
INSTALL_DIR="${PINBOX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${PINBOX_VERSION:-latest}"

die() {
  echo "pinbox install: $1" >&2
  exit 1
}

# uname → the same os/cpu pair tools/release/targets.ts ships.
os="$(uname -s)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) die "unsupported OS '$os' (supported: Darwin, Linux)" ;;
esac

arch="$(uname -m)"
case "$arch" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) die "unsupported architecture '$arch' (supported: arm64, x86_64)" ;;
esac

asset="pinbox-${os}-${arch}"
if [ "$VERSION" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "neither curl nor wget is available"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "pinbox install: downloading ${asset} (${VERSION})"
fetch "${base}/${asset}" "${tmp}/${asset}" || die "download failed: ${base}/${asset}"
fetch "${base}/${asset}.sha256" "${tmp}/${asset}.sha256" ||
  die "checksum download failed: ${base}/${asset}.sha256"

# Verify before anything becomes executable. The checksum file is `<hash>  <asset>`, so the
# check runs from the temp dir where that relative name resolves.
if command -v shasum >/dev/null 2>&1; then
  (cd "$tmp" && shasum -a 256 -c "${asset}.sha256" >/dev/null) || die "checksum mismatch"
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c "${asset}.sha256" >/dev/null) || die "checksum mismatch"
else
  die "no sha256 tool found (shasum or sha256sum) — refusing to install unverified"
fi

mkdir -p "$INSTALL_DIR"
chmod 755 "${tmp}/${asset}"
mv "${tmp}/${asset}" "${INSTALL_DIR}/pinbox"

echo "pinbox install: installed to ${INSTALL_DIR}/pinbox"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) "${INSTALL_DIR}/pinbox" --version >/dev/null && echo "pinbox install: run \`pinbox init\` to get started" ;;
  *)
    echo "pinbox install: ${INSTALL_DIR} is not on your PATH. Add it:" >&2
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\"" >&2
    ;;
esac
