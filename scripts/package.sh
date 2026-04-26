#!/usr/bin/env bash

# Stop on first error
set -e

# Go to project root (in case script is run from scripts/ directory)
cd "$(dirname "$0")/.."

echo "📦 Packaging AI Auto Agent extension..."

# 1. Clean previous builds if any
rm -f *.vsix

# 2. Package via vsce (this will automatically run the prepare/prepublish scripts if any)
# We use --no-dependencies because esbuild already bundles everything into dist/extension.js
npx vsce package --no-dependencies

echo "✅ Package created successfully! You can install the .vsix in VS Code/Antigravity."
