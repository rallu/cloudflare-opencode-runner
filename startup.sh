#!/bin/bash
cd /home/dev
# Curated image toolchains (mise shims). bash -lc for SETUP_COMMANDS must see these.
export PATH="/opt/mise/shims:/opt/rust/cargo/bin:/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
mkdir -p /tmp
: > /tmp/opencode.log
echo "startup.sh begin $(date -Iseconds 2>/dev/null || date) run=${RUN_ID:-none}" >> /tmp/opencode.log
echo "PATH=$PATH" >> /tmp/opencode.log
echo "RUN_BRANCH=${RUN_BRANCH:-} WORK_BRANCH=${WORK_BRANCH:-}" >> /tmp/opencode.log
echo "which opencode: $(command -v opencode || echo MISSING)" >> /tmp/opencode.log
echo "which node: $(command -v node || echo MISSING)" >> /tmp/opencode.log

if [ -n "$GIT_TOKEN" ]; then
  git config --global url."https://${GIT_TOKEN}@github.com/".insteadOf "https://github.com/" >> /tmp/opencode.log 2>&1 || true
fi
FIRST_REPO_DIR=""
if [ -n "$GIT_REPOS" ]; then
  IFS=',' read -ra REPOS <<< "$GIT_REPOS"
  for repo in "${REPOS[@]}"; do
    repo="$(echo "$repo" | xargs)"
    [ -z "$repo" ] && continue
    repo_name=$(basename "$repo" .git)
    if [ ! -d "$repo_name" ]; then
      echo "Cloning $repo..." >> /tmp/opencode.log
      # Prefer base RUN_BRANCH when set; fall back to default branch.
      if [ -n "$RUN_BRANCH" ]; then
        git clone --branch "$RUN_BRANCH" --single-branch "$repo" "$repo_name" >> /tmp/opencode.log 2>&1 \
          || git clone "$repo" "$repo_name" >> /tmp/opencode.log 2>&1 \
          || echo "Failed to clone $repo" >> /tmp/opencode.log
      else
        git clone "$repo" "$repo_name" >> /tmp/opencode.log 2>&1 || echo "Failed to clone $repo" >> /tmp/opencode.log
      fi
    fi

    if [ -d "$repo_name" ]; then
      (
        cd "$repo_name" || exit 0
        echo "git fetch origin in $repo_name" >> /tmp/opencode.log
        git fetch origin >> /tmp/opencode.log 2>&1 || true

        # Resolve base ref: RUN_BRANCH if set, else origin's default branch.
        checkout_base() {
          if [ -n "$RUN_BRANCH" ]; then
            if git rev-parse --verify "refs/remotes/origin/${RUN_BRANCH}" >/dev/null 2>&1; then
              git checkout -B "$RUN_BRANCH" "origin/${RUN_BRANCH}" >> /tmp/opencode.log 2>&1
              return $?
            fi
            git checkout "$RUN_BRANCH" >> /tmp/opencode.log 2>&1
            return $?
          fi
          local def
          def="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')" || def=""
          if [ -n "$def" ] && git rev-parse --verify "refs/remotes/origin/${def}" >/dev/null 2>&1; then
            git checkout -B "$def" "origin/${def}" >> /tmp/opencode.log 2>&1
            return $?
          fi
          if git rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1; then
            git checkout -B main origin/main >> /tmp/opencode.log 2>&1
            return $?
          fi
          if git rev-parse --verify refs/remotes/origin/master >/dev/null 2>&1; then
            git checkout -B master origin/master >> /tmp/opencode.log 2>&1
            return $?
          fi
          return 0
        }

        if [ -n "$WORK_BRANCH" ]; then
          if git rev-parse --verify "refs/remotes/origin/${WORK_BRANCH}" >/dev/null 2>&1; then
            echo "Restoring work branch from origin/${WORK_BRANCH}" >> /tmp/opencode.log
            if git checkout -B "$WORK_BRANCH" "origin/${WORK_BRANCH}" >> /tmp/opencode.log 2>&1; then
              echo "Restored work branch: ${WORK_BRANCH} (from remote)" >> /tmp/opencode.log
            else
              git checkout "$WORK_BRANCH" >> /tmp/opencode.log 2>&1 || true
              git pull --ff-only origin "$WORK_BRANCH" >> /tmp/opencode.log 2>&1 || true
              echo "Checked out work branch: ${WORK_BRANCH} (fallback)" >> /tmp/opencode.log
            fi
          else
            echo "origin/${WORK_BRANCH} not found; creating from base (RUN_BRANCH=${RUN_BRANCH:-default})" >> /tmp/opencode.log
            checkout_base || true
            git checkout -B "$WORK_BRANCH" >> /tmp/opencode.log 2>&1 || true
            echo "Created local work branch: ${WORK_BRANCH}" >> /tmp/opencode.log
          fi
        else
          # No WORK_BRANCH — stay on / check out base only.
          checkout_base || true
          echo "No WORK_BRANCH; on base $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)" >> /tmp/opencode.log
        fi

        echo "Active branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)" >> /tmp/opencode.log
        echo "HEAD: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)" >> /tmp/opencode.log
      )
    fi

    if [ -z "$FIRST_REPO_DIR" ] && [ -d "$repo_name" ]; then
      FIRST_REPO_DIR="/home/dev/$repo_name"
    fi
  done
fi

# Serve from the first cloned repo so OpenCode's default /path is the git worktree
# (project list includes the real project, not only global "/").
if [ -n "$FIRST_REPO_DIR" ]; then
  echo "cd into worktree $FIRST_REPO_DIR before opencode serve" >> /tmp/opencode.log
  cd "$FIRST_REPO_DIR" || {
    echo "Failed to cd $FIRST_REPO_DIR" >> /tmp/opencode.log
    echo "Failed to cd $FIRST_REPO_DIR" >&2
    exit 1
  }
  printf '%s' "$FIRST_REPO_DIR" > /tmp/opencode-worktree
elif [ -n "$GIT_REPOS" ]; then
  # Do not start OpenCode from $HOME — the UI would show .cache/.config/.local/.npm
  # and hide the missing project. Serve crash keep-alive so the Worker can read
  # /tmp/opencode.log and report a clear clone/auth error.
  echo "GIT_REPOS set but no cloned repo dir found; clone failed (check GIT_TOKEN for private repos)" >> /tmp/opencode.log
  echo "GIT_REPOS set but no cloned repo dir found; clone failed (check GIT_TOKEN for private repos)" >&2
  echo "Starting crash keep-alive on 4096 (clone failed)..." >> /tmp/opencode.log
  if [ -f /home/dev/keepalive.js ]; then
    exec node /home/dev/keepalive.js
  fi
  exec node -e 'require("http").createServer((q,s)=>{const u=(q.url||"/").split("?")[0];if(u==="/global/health"){s.writeHead(200,{"Content-Type":"application/json"});s.end(JSON.stringify({healthy:false,crash:true,cloneFailed:true}))}else if(u==="/__opencode-log"){s.writeHead(200,{"Content-Type":"text/plain"});try{s.end(require("fs").readFileSync("/tmp/opencode.log","utf8"))}catch(e){s.end(String(e))}}else{s.writeHead(503);s.end("clone failed")}}).listen(4096,"0.0.0.0");setInterval(()=>{},1<<30)'
fi

# Optional post-clone setup (e.g. npm install). Fail startup on non-zero so bootstrap surfaces errors.
# SETUP_COMMANDS: newline-separated and/or |||-separated commands from the Worker.
if [ -n "$SETUP_COMMANDS" ]; then
  echo "Running SETUP_COMMANDS in $(pwd)..." >> /tmp/opencode.log
  # Normalize ||| separators to newlines, then run each non-empty line
  _setup_raw="$(printf '%s' "$SETUP_COMMANDS" | sed 's/|||/\n/g')"
  while IFS= read -r _cmd || [ -n "$_cmd" ]; do
    # trim leading/trailing whitespace
    _cmd="$(printf '%s' "$_cmd" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$_cmd" ] && continue
    echo "+ bash -c: $_cmd" >> /tmp/opencode.log
    if ! bash -c "$_cmd" >> /tmp/opencode.log 2>&1; then
      _ec=$?
      echo "SETUP_COMMAND failed (exit $_ec): $_cmd" >> /tmp/opencode.log
      echo "SETUP_COMMAND failed (exit $_ec): $_cmd" >&2
      exit 1
    fi
    echo "SETUP_COMMAND ok: $_cmd" >> /tmp/opencode.log
  done <<EOFINNER
${_setup_raw}
EOFINNER
  echo "SETUP_COMMANDS finished successfully" >> /tmp/opencode.log
fi

echo "Starting OpenCode on 0.0.0.0:4096 from $(pwd)..." >> /tmp/opencode.log
opencode serve --port 4096 --hostname 0.0.0.0 >> /tmp/opencode.log 2>&1 &
OPID=$!
echo "opencode pid=$OPID" >> /tmp/opencode.log

# Wait until opencode exits (success path keeps container alive via this wait)
wait "$OPID"
echo "opencode exited with code $?" >> /tmp/opencode.log

echo "Starting crash keep-alive on 4096..." >> /tmp/opencode.log
if [ -f /home/dev/keepalive.js ]; then
  exec node /home/dev/keepalive.js
fi
exec node -e 'require("http").createServer((q,s)=>{const u=(q.url||"/").split("?")[0];if(u==="/global/health"){s.writeHead(200,{"Content-Type":"application/json"});s.end(JSON.stringify({healthy:false,crash:true}))}else if(u==="/__opencode-log"){s.writeHead(200,{"Content-Type":"text/plain"});try{s.end(require("fs").readFileSync("/tmp/opencode.log","utf8"))}catch(e){s.end(String(e))}}else{s.writeHead(503);s.end("crashed")}}).listen(4096,"0.0.0.0");setInterval(()=>{},1<<30)'
