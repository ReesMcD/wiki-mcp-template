#!/bin/bash
# Claude Code on the web: install the MCP server's dependencies so tests,
# typecheck and the local wiki tools in .mcp.json work from the start.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR/mcp"
# npm install (not ci) reuses what's already there, so cached containers start fast.
npm install --no-audit --no-fund --loglevel=error
