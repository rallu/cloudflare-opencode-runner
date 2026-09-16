#!/bin/bash
cd /home/dev
# Curated image toolchains (mise shims). bash -lc for SETUP_COMMANDS must see these.
export PATH="/opt/mise/shims:/opt/rust/cargo/bin:/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
mkdir -p /tmp
: > /tmp/opencode.log
echo "startup.sh begin $(date -Iseconds 2>/dev/null || date) run=${RUN_ID:-none}" >> /tmp/opencode.log
echo "PATH=$PATH" >> /tmp/opencode.log
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
      if [ -n "$RUN_BRANCH" ]; then
        git clone --branch "$RUN_BRANCH" --single-branch "$repo" "$repo_name" >> /tmp/opencode.log 2>&1 || git clone "$repo" "$repo_name" >> /tmp/opencode.log 2>&1 || echo "Failed to clone $repo" >> /tmp/opencode.log
      else
        git clone "$repo" "$repo_name" >> /tmp/opencode.log 2>&1 || echo "Failed to clone $repo" >> /tmp/opencode.log
      fi
    fi
    if [ -n "$RUN_BRANCH" ] && [ -d "$repo_name" ]; then
      (cd "$repo_name" && git fetch origin "$RUN_BRANCH" && git checkout "$RUN_BRANCH") >> /tmp/opencode.log 2>&1 || true
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
  cd "$FIRST_REPO_DIR" || echo "Failed to cd $FIRST_REPO_DIR" >> /tmp/opencode.log
elif [ -n "$GIT_REPOS" ]; then
  echo "GIT_REPOS set but no cloned repo dir found; staying in $(pwd)" >> /tmp/opencode.log
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
  done <<EOF
${_setup_raw}
EOF
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
