#!/usr/bin/env bash
# FT_extensions installer (pnpm + supply-chain hardening) — macOS / Linux
# Mirrors sample_install.bat. Run from this folder:  ./sample_install.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "============================================================"
echo " FT_extensions installer (pnpm + supply-chain hardening)"
echo "============================================================"
echo

# --- 1) Node.js ---------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js not found."
    case "$(uname -s)" in
        Darwin) echo "        Install via Homebrew:  brew install node" ;;
        Linux)  echo "        Install via your package manager, or:  https://nodejs.org/" ;;
    esac
    exit 1
fi
NODE_VER=$(node --version)
echo "Node.js : ${NODE_VER}"

# Require Node 18+ (corepack ships from 16.10, pnpm 11 needs 18.12+).
NODE_MAJOR=${NODE_VER#v}; NODE_MAJOR=${NODE_MAJOR%%.*}
if [ "${NODE_MAJOR}" -lt 18 ]; then
    echo "[ERROR] Node.js v18 or later is required (found ${NODE_VER})."
    exit 1
fi

if ! command -v corepack >/dev/null 2>&1; then
    echo "[ERROR] corepack not found. It ships with Node.js v16.10+; reinstall Node.js."
    exit 1
fi

# --- 2) Corepack + pnpm ------------------------------------------
echo
echo "[1/4] Preparing pnpm via corepack ..."

# Try to install global "pnpm" shim. On macOS this usually works without sudo
# when Node lives under /opt/homebrew or ~/.nvm; system-wide installs may
# refuse. Fall back to "corepack pnpm" if enable fails.
if corepack enable >/dev/null 2>&1; then
    PNPM_CMD="pnpm"
else
    echo "  (corepack enable skipped — using \"corepack pnpm\" instead)"
    PNPM_CMD="corepack pnpm"
fi

# package.json in this folder pins pnpm@11.1.2 via the "packageManager" field.
corepack prepare pnpm@11.1.2 --activate
PNPM_VER=$(${PNPM_CMD} --version)
echo "pnpm    : ${PNPM_VER}"

# --- 3) Clean legacy npm artifacts -------------------------------
echo
echo "[2/4] Cleaning legacy npm artifacts ..."
if [ -f package-lock.json ]; then
    rm -f package-lock.json
    echo "  removed package-lock.json"
fi
if [ -d node_modules ]; then
    echo "  removing node_modules (may take a minute) ..."
    rm -rf node_modules
fi

# --- 4) pnpm install ---------------------------------------------
echo
echo "[3/4] Installing dependencies via pnpm ..."
echo "  (rejecting any package version published in the last 3 days)"
${PNPM_CMD} install

# --- 5) Smoke check: lint ----------------------------------------
echo
echo "[4/4] Running lint as a build smoke check ..."
LINT_RC=0
${PNPM_CMD} run lint || LINT_RC=$?
if [ "${LINT_RC}" -ne 0 ]; then
    echo "[WARN] lint reported issues (exit ${LINT_RC}). Install itself succeeded."
fi

echo
echo "============================================================"
echo " Done."
echo "   Start receiver : ${PNPM_CMD} start"
echo "   Re-run lint    : ${PNPM_CMD} run lint"
if [ "${PNPM_CMD}" = "corepack pnpm" ]; then
    echo "   (For bare \"pnpm\" command, run: sudo corepack enable)"
fi
echo "============================================================"
