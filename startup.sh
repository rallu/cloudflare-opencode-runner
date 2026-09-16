#!/bin/bash
set -e

cd /home/dev

if [ -n "$GIT_TOKEN" ]; then
  git config --global url."https://${GIT_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

if [ -n "$GIT_REPOS" ]; then
  IFS=',' read -ra REPOS <<< "$GIT_REPOS"
  for repo in "${REPOS[@]}"; do
    repo_name=$(basename "$repo" .git)
    if [ ! -d "$repo_name" ]; then
      echo "Cloning $repo..."
      if [ -n "$RUN_BRANCH" ]; then
        git clone --branch "$RUN_BRANCH" --single-branch "$repo" "$repo_name" \
          || git clone "$repo" "$repo_name"
      else
        git clone "$repo" "$repo_name" || echo "Failed to clone $repo"
      fi
    else
      echo "Directory $repo_name already exists, skipping clone"
    fi
    if [ -n "$RUN_BRANCH" ] && [ -d "$repo_name" ]; then
      (cd "$repo_name" && git fetch origin "$RUN_BRANCH" && git checkout "$RUN_BRANCH") || true
    fi
  done
fi

echo "Starting OpenCode headless server on 0.0.0.0:4096 (run=${RUN_ID:-none})..."
exec opencode serve --port 4096 --hostname 0.0.0.0
