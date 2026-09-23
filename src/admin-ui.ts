export function getAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode Runner Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .status-ready, .status-healthy, .status-running { color: #4ade80; }
    .status-starting { color: #facc15; }
    .status-stopped, .status-stopping { color: #fb923c; }
    .status-error, .status-destroyed { color: #f87171; }
    .status-unknown { color: #9ca3af; }
    .pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
  </style>
</head>
<body class="bg-gray-900 text-white min-h-screen">
  <div class="container mx-auto px-4 py-8 max-w-5xl">
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-3xl font-bold">OpenCode Runner Admin</h1>
        <p class="text-gray-400 mt-1">Browser admin via /admin/api (Access). Automation uses /api/runs + bearer.</p>
      </div>
      <div class="flex items-center gap-3">
        <button onclick="createRun()" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded text-sm font-medium">Create run</button>
        <button onclick="refreshRuns()" class="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded text-sm">Refresh</button>
        <span id="live-indicator" class="w-3 h-3 rounded-full bg-green-500 pulse"></span>
      </div>
    </div>

    <div id="action-result" class="mb-4 text-sm min-h-[20px]"></div>

    <div class="bg-gray-800 rounded-lg p-6 mb-6 border border-gray-700">
      <h2 class="text-xl font-semibold mb-4">Runs</h2>
      <div id="runs-list" class="space-y-3">
        <p class="text-gray-400">Loading runs...</p>
      </div>
    </div>

    <div class="bg-gray-800 rounded-lg p-6 border border-gray-700">
      <h2 class="text-xl font-semibold mb-2">Selected run detail</h2>
      <p id="selected-label" class="text-gray-400 text-sm mb-4">Select a run to view status</p>
      <div id="status" class="space-y-3 mb-4"></div>
      <div class="flex gap-3 flex-wrap">
        <button id="btn-start" onclick="runAction('start')" class="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-4 py-2 rounded" disabled>Start</button>
        <button id="btn-stop" onclick="runAction('stop')" class="bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 px-4 py-2 rounded" disabled>Stop</button>
        <button id="btn-restart" onclick="runAction('restart')" class="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 px-4 py-2 rounded" disabled>Restart</button>
        <button id="btn-destroy" onclick="runAction('destroy')" class="bg-red-700 hover:bg-red-800 disabled:bg-gray-600 px-4 py-2 rounded" disabled>Destroy</button>
      </div>
    </div>
  </div>

  <script>
    let selectedRunId = null;
    let autoRefreshInterval = null;

    async function fetchJSON(url, options = {}) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
          credentials: 'include',
        });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        if (!response.ok) {
          return { error: data.error || data.message || text || response.statusText, status: response.status, ...data };
        }
        return data;
      } catch (error) {
        return { error: error.message };
      }
    }

    function showResult(message, ok = true) {
      const el = document.getElementById('action-result');
      el.className = 'mb-4 text-sm ' + (ok === 'info' ? 'text-blue-400' : ok ? 'text-green-400' : 'text-red-400');
      el.textContent = message || '';
    }

    function statusClass(status) {
      return 'status-' + (status || 'unknown');
    }

    async function openRunUi(runId, evt) {
      if (evt) evt.preventDefault();
      const data = await fetchJSON('/admin/api/status?runId=' + encodeURIComponent(runId));
      const href = (data && (data.openCodeUrl || data.url)) || ('/r/' + encodeURIComponent(runId) + '/');
      window.open(href, '_blank');
    }

    async function loadRuns() {
      // Browser admin uses /admin/api/* only (Access cookie). Never call /api/runs (bearer).
      return fetchJSON('/admin/api/list');
    }

    async function refreshRuns() {
      const data = await loadRuns();
      const list = document.getElementById('runs-list');
      if (data.error) {
        list.innerHTML = '<p class="text-red-400">Error: ' + data.error + '</p>';
        return;
      }
      const runs = data.runs || [];
      if (!runs.length) {
        list.innerHTML = '<p class="text-gray-500 italic">No runs registered yet. Create one to get started.</p>';
        return;
      }
      list.innerHTML = runs.map(r => {
        const active = r.runId === selectedRunId ? 'ring-2 ring-blue-500' : '';
        const ui = '/r/' + encodeURIComponent(r.runId) + '/';
        return \`
          <div class="bg-gray-900/50 rounded-lg p-4 \${active} cursor-pointer hover:bg-gray-900" onclick="selectRun('\${r.runId}')">
            <div class="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div class="font-mono text-sm">\${r.runId}</div>
                <div class="text-xs text-gray-400 mt-1">
                  <span class="\${statusClass(r.status)}">\${(r.status || 'unknown').toUpperCase()}</span>
                  \${r.repo ? ' · ' + r.repo : ''}
                  \${r.branch ? '@' + r.branch : ''}
                </div>
                \${r.error ? '<div class="text-xs text-red-400 mt-1 truncate" title="' + String(r.error).replace(/"/g,'&quot;') + '">' + r.error + '</div>' : ''}
              </div>
              <div class="flex gap-2 items-center">
                <a href="\${ui}" target="_blank" onclick="event.stopPropagation(); openRunUi('\${r.runId}', event)" class="text-xs bg-blue-700 hover:bg-blue-600 px-3 py-1 rounded">Open UI</a>
                <button onclick="event.stopPropagation(); selectRun('\${r.runId}'); runAction('start')" class="text-xs bg-green-700 hover:bg-green-600 px-2 py-1 rounded">Start</button>
                <button onclick="event.stopPropagation(); selectRun('\${r.runId}'); runAction('stop')" class="text-xs bg-yellow-700 hover:bg-yellow-600 px-2 py-1 rounded">Stop</button>
                <button onclick="event.stopPropagation(); selectRun('\${r.runId}'); runAction('restart')" class="text-xs bg-orange-700 hover:bg-orange-600 px-2 py-1 rounded">Restart</button>
                <button onclick="event.stopPropagation(); selectRun('\${r.runId}'); runAction('destroy')" class="text-xs bg-red-800 hover:bg-red-700 px-2 py-1 rounded">Destroy</button>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    async function selectRun(runId) {
      selectedRunId = runId;
      document.getElementById('selected-label').textContent = 'Run: ' + runId;
      ['btn-start','btn-stop','btn-restart','btn-destroy'].forEach(id => {
        document.getElementById(id).disabled = false;
      });
      await refreshRuns();
      await refreshSelectedStatus();
    }

    async function refreshSelectedStatus() {
      const statusDiv = document.getElementById('status');
      if (!selectedRunId) {
        statusDiv.innerHTML = '';
        return;
      }
      const data = await fetchJSON('/admin/api/status?runId=' + encodeURIComponent(selectedRunId));
      if (data.error) {
        statusDiv.innerHTML = '<p class="text-red-400">' + data.error + '</p>';
        return;
      }
      const ui = data.openCodeUrl || data.url || ('/r/' + encodeURIComponent(selectedRunId) + '/');
      const sessionLine = data.run?.sessionId
        ? '<div class="flex justify-between"><span class="text-gray-400">Session</span><span class="font-mono text-xs truncate" title="' + data.run.sessionId + '">' + data.run.sessionId + '</span></div>'
        : '';
      const dirLine = data.run?.directory
        ? '<div class="flex justify-between"><span class="text-gray-400">Directory</span><span class="font-mono text-xs truncate" title="' + data.run.directory + '">' + data.run.directory + '</span></div>'
        : '';
      statusDiv.innerHTML = \`
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div class="bg-gray-900/50 rounded p-3 space-y-1">
            <div class="flex justify-between"><span class="text-gray-400">Container</span><span class="\${statusClass(data.status)}">\${data.status || 'unknown'}</span></div>
            <div class="flex justify-between"><span class="text-gray-400">Running</span><span>\${data.running ? 'Yes' : 'No'}</span></div>
            <div class="flex justify-between"><span class="text-gray-400">Run status</span><span class="\${statusClass(data.run?.status)}">\${data.run?.status || 'n/a'}</span></div>
            \${data.exitCode != null ? '<div class="flex justify-between"><span class="text-gray-400">Exit</span><span class="text-red-400">' + data.exitCode + '</span></div>' : ''}
          </div>
          <div class="bg-gray-900/50 rounded p-3 space-y-1">
            <div class="flex justify-between gap-2"><span class="text-gray-400">UI</span><a class="text-blue-400 truncate" href="\${ui}" target="_blank" title="\${ui}">Open deep link</a></div>
            \${sessionLine}
            \${dirLine}
            <div class="flex justify-between"><span class="text-gray-400">Expires</span><span class="text-xs">\${data.run?.expiresAt ? new Date(data.run.expiresAt).toLocaleString() : 'n/a'}</span></div>
            <div class="flex justify-between"><span class="text-gray-400">Last change</span><span class="text-xs">\${data.lastChangeFormatted || 'n/a'}</span></div>
          </div>
        </div>
        \${data.run?.error ? '<p class="text-red-400 text-sm mt-2">' + data.run.error + '</p>' : ''}
      \`;
    }

    async function runAction(action) {
      if (!selectedRunId) {
        showResult('Select a run first', false);
        return;
      }
      showResult(action + ' ' + selectedRunId + '...', 'info');
      const data = await fetchJSON(
        '/admin/api/' + action + '?runId=' + encodeURIComponent(selectedRunId),
        { method: 'POST' },
      );
      if (data.error && !data.success) {
        showResult(data.error + (data.crashLog ? ' (see crashLog)' : ''), false);
      } else {
        showResult(data.message || (action + ' ok'), true);
      }
      setTimeout(async () => {
        await refreshRuns();
        await refreshSelectedStatus();
      }, 1500);
    }

    async function createRun() {
      const runId = 'admin-' + Date.now().toString(36);
      showResult('Creating ' + runId + '...', 'info');
      const data = await fetchJSON('/admin/api/create', {
        method: 'POST',
        body: JSON.stringify({ runId }),
      });
      if (data.error || data.success === false) {
        showResult((data.error || 'create failed') + (data.crashLog ? ' | crashLog available in response' : ''), false);
        console.log('create response', data);
      } else {
        showResult('Created ' + (data.runId || runId) + (data.openCodeUrl ? ' → ' + data.openCodeUrl : ''), true);
      }
      selectedRunId = data.runId || runId;
      await refreshRuns();
      await refreshSelectedStatus();
    }

    refreshRuns();
    autoRefreshInterval = setInterval(refreshRuns, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshRuns();
    });
  </script>
</body>
</html>`;
}
