#!/usr/bin/env bash
# Pull improvements from the wiki template into this wiki:
#   scripts/update-from-template.sh
# Safe to run any time: it stops before touching anything if you have
# uncommitted changes, and on conflicts it tells you how to finish or undo.
set -euo pipefail

TEMPLATE_URL="${TEMPLATE_URL:-https://github.com/ReesMcD/wiki-mcp-template.git}"
TEMPLATE_BRANCH="${TEMPLATE_BRANCH:-main}"
UPSTREAM="template/$TEMPLATE_BRANCH"

cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "You have uncommitted changes. Commit or stash them first, then run this again." >&2
  exit 1
fi

if git remote get-url template >/dev/null 2>&1; then
  git remote set-url template "$TEMPLATE_URL"
else
  git remote add template "$TEMPLATE_URL"
fi
git fetch --quiet template "$TEMPLATE_BRANCH"

if git merge-base --is-ancestor "$UPSTREAM" HEAD; then
  echo "Already up to date with the template."
  exit 0
fi

if ! git merge-base HEAD "$UPSTREAM" >/dev/null 2>&1; then
  # First update. "Use this template" copies the template's files into a new
  # history, so git sees no common ancestor, and a plain merge would bring
  # back every page you deleted and conflict on every file you changed.
  # Find the template commit this wiki started from (same files as the
  # wiki's first commit) and record it as the common ancestor.
  root_tree="$(git rev-parse "$(git rev-list --max-parents=0 HEAD | tail -n 1)^{tree}")"
  start=""
  for commit in $(git rev-list "$UPSTREAM"); do
    if [ "$(git rev-parse "$commit^{tree}")" = "$root_tree" ]; then
      start="$commit"
      break
    fi
  done
  if [ -n "$start" ]; then
    echo "This wiki was created from template commit ${start:0:7}; linking the histories."
    git merge --quiet --no-edit --allow-unrelated-histories -s ours -m "Link history to the wiki template (${start:0:7})" "$start"
  else
    echo "Couldn't find the template version this wiki started from (its first commit was edited)."
    echo "Merging anyway: expect conflicts, and pages you deleted may come back."
  fi
fi

if git merge --no-edit --allow-unrelated-histories -m "Update from the wiki template" "$UPSTREAM"; then
  echo
  echo "Updated from the template. Check the result, then run: cd mcp && npm install && npm test"
  echo "Push when you're happy; Vercel redeploys if mcp/ changed."
else
  echo
  echo "Some files you customized were also changed in the template:"
  git diff --name-only --diff-filter=U | sed 's/^/  - /'
  echo
  echo "For each one, edit it to keep what you want, or pick a side:"
  echo "  keep yours:          git checkout --ours -- <file>"
  echo "  take the template's: git checkout --theirs -- <file>"
  echo "Then: git add -A && git commit --no-edit"
  echo "Or undo the whole update: git merge --abort"
  exit 1
fi
