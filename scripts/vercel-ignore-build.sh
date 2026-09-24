#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json ignoreCommand). Exit 0 cancels the build; exit 1 builds.
#
# Skips the build only when every commit since this branch's last successful deployment changed
# nothing but Markdown, agent config (.claude/), CI config (.github/) or .editorconfig. Anything
# else, including a first deployment or a previous commit that isn't in Vercel's shallow clone
# (depth 10), builds as normal.

prev="$VERCEL_GIT_PREVIOUS_SHA"

if [ -z "$prev" ] || ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
  echo "ignore-build: no previous deployment to compare with; building."
  exit 1
fi

if git diff --quiet "$prev" HEAD -- . ':(exclude)*.md' ':(exclude).claude' ':(exclude).github' ':(exclude).editorconfig'; then
  echo "ignore-build: only docs, agent or CI config changed since ${prev}; skipping the build."
  exit 0
fi

echo "ignore-build: app files changed since ${prev}; building."
exit 1
