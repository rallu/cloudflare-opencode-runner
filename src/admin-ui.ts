export function getAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenCode Container Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .status-healthy { color: #4ade80; }
    .status-running { color: #facc15; }
    .status-stopped { color: #f87171; }
    .status-stopping { color: #fb923c; }
    .status-unknown { color: #9ca3af; }
    .pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
  </style>
</head>
<body class="bg-gray-900 text-white min-h-screen">
  <div class="container mx-auto px-4 py-8 max-w-5xl">
    <!-- Header -->
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-3xl font-bold">OpenCode Container Admin</h1>
        <p class="text-gray-400 mt-1">Manage your OpenCode server instance</p>
      </div>
      <div class="flex items-center gap-2">
        <span id="live-indicator" class="w-3 h-3 rounded-full bg-green-500 pulse"></span>
        <span class="text-sm text-gray-400">Live</span>
      </div>
    </div>
    
    <!-- Status Card -->
    <div class="bg-gray-800 rounded-lg p-6 mb-6 border border-gray-700">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-semibold">Container Status</h2>
        <button 
          onclick="refreshStatus()" 
          class="text-sm bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded transition-colors"
        >
          Refresh
        </button>
      </div>
      <div id="status" class="space-y-3">
        <div class="flex items-center gap-2">
          <div class="w-4 h-4 rounded-full bg-gray-600 animate-pulse"></div>
          <span class="text-gray-400">Loading status...</span>
        </div>
      </div>
    </div>
    
    <!-- Controls -->
    <div class="bg-gray-800 rounded-lg p-6 mb-6 border border-gray-700">
      <h2 class="text-xl font-semibold mb-4">Container Controls</h2>
      <div class="flex gap-4 flex-wrap">
        <button 
          onclick="startContainer()" 
          id="btn-start"
          class="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-6 py-2.5 rounded font-medium transition-colors flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/></svg>
          Start
        </button>
        <button 
          onclick="stopContainer()" 
          id="btn-stop"
          class="bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-6 py-2.5 rounded font-medium transition-colors flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M5.75 3A1.75 1.75 0 004 4.75v10.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0016 15.25V4.75A1.75 1.75 0 0014.25 3h-8.5z"/></svg>
          Stop
        </button>
        <button 
          onclick="restartContainer()" 
          id="btn-restart"
          class="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-6 py-2.5 rounded font-medium transition-colors flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0v2.43l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389 5.5 5.5 0 019.201-2.466l.312.311h-2.433a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clip-rule="evenodd"/></svg>
          Restart
        </button>
      </div>
      <div id="action-result" class="mt-4 text-sm min-h-[24px]"></div>
    </div>
    
    <!-- Configuration -->
    <div class="bg-gray-800 rounded-lg p-6 mb-6 border border-gray-700">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-semibold">Configuration</h2>
        <button 
          onclick="refreshConfig()" 
          class="text-sm bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded transition-colors"
        >
          Refresh
        </button>
      </div>
      <div id="config" class="space-y-4">
        <p class="text-gray-400">Loading configuration...</p>
      </div>
    </div>

    <!-- Quick Links -->
    <div class="bg-gray-800 rounded-lg p-6 mb-6 border border-gray-700">
      <h2 class="text-xl font-semibold mb-4">Quick Links</h2>
      <div class="flex gap-4 flex-wrap">
        <a 
          href="/" 
          target="_blank"
          class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded transition-colors flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
          Open OpenCode Web UI
        </a>
        <a 
          href="/global/health" 
          target="_blank"
          class="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded transition-colors flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          Health Check
        </a>
        <a 
          href="/doc" 
          target="_blank"
          class="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded transition-colors flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
          API Docs
        </a>
      </div>
    </div>
    
    <!-- Footer -->
    <div class="text-center text-gray-500 text-sm mt-8">
      <p>OpenCode on Cloudflare Containers</p>
    </div>
  </div>

  <script>
    const API_BASE = '/admin/api';
    let autoRefreshInterval = null;
    
    async function fetchAPI(endpoint, options = {}) {
      try {
        const response = await fetch(API_BASE + endpoint, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || response.statusText);
        }
        return await response.json();
      } catch (error) {
        console.error('API Error:', error);
        return { error: error.message };
      }
    }
    
    function formatUptime(ms) {
      if (!ms) return 'N/A';
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      if (days > 0) return days + 'd ' + (hours % 24) + 'h';
      if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
      if (minutes > 0) return minutes + 'm ' + (seconds % 60) + 's';
      return seconds + 's';
    }
    
    async function refreshStatus() {
      const data = await fetchAPI('/status');
      const statusDiv = document.getElementById('status');
      
      if (data.error) {
        statusDiv.innerHTML = \`
          <div class="bg-red-900/30 border border-red-700 rounded p-3">
            <p class="text-red-400 font-medium">Error fetching status</p>
            <p class="text-red-300 text-sm mt-1">\${data.error}</p>
          </div>
        \`;
        updateButtons('unknown');
        return;
      }
      
      const statusClass = 'status-' + (data.status || 'unknown');
      const isRunning = data.status === 'running' || data.status === 'healthy';
      
      statusDiv.innerHTML = \`
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="bg-gray-900/50 rounded-lg p-4">
            <div class="flex items-center gap-3 mb-3">
              <div class="w-4 h-4 rounded-full \${isRunning ? 'bg-green-500' : 'bg-red-500'}"></div>
              <span class="text-lg font-semibold \${statusClass}">\${(data.status || 'unknown').toUpperCase()}</span>
            </div>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-gray-400">Running:</span>
                <span>\${data.running ? 'Yes' : 'No'}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">Uptime:</span>
                <span>\${formatUptime(data.uptime)}</span>
              </div>
              \${data.exitCode !== null && data.exitCode !== undefined ? \`
              <div class="flex justify-between">
                <span class="text-gray-400">Exit Code:</span>
                <span class="text-red-400">\${data.exitCode}</span>
              </div>
              \` : ''}
            </div>
          </div>
          
          <div class="bg-gray-900/50 rounded-lg p-4">
            <h3 class="font-medium mb-3 text-gray-300">Container Info</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between">
                <span class="text-gray-400">Port:</span>
                <span>\${data.defaultPort}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">Sleep After:</span>
                <span>\${data.sleepAfter}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">Internet:</span>
                <span>\${data.enableInternet ? 'Enabled' : 'Disabled'}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-400">Last Change:</span>
                <span class="text-xs">\${data.lastChangeFormatted || 'N/A'}</span>
              </div>
            </div>
          </div>
        </div>
      \`;
      
      updateButtons(data.status, data.running);
    }
    
    function updateButtons(status, running) {
      const btnStart = document.getElementById('btn-start');
      const btnStop = document.getElementById('btn-stop');
      const btnRestart = document.getElementById('btn-restart');
      
      const isRunning = status === 'running' || status === 'healthy';
      const isStopping = status === 'stopping';
      
      btnStart.disabled = isRunning || isStopping;
      btnStop.disabled = !isRunning || isStopping;
      btnRestart.disabled = isStopping;
    }
    
    async function refreshConfig() {
      const data = await fetchAPI('/config');
      const configDiv = document.getElementById('config');
      
      if (data.error) {
        configDiv.innerHTML = '<p class="text-red-400">Error: ' + data.error + '</p>';
        return;
      }
      
      configDiv.innerHTML = \`
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="bg-gray-900/50 rounded-lg p-4">
            <h3 class="font-medium mb-3 text-gray-300">Secrets Status</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between items-center">
                <span class="text-gray-400">Server Password:</span>
                <span class="\${data.envVars?.hasServerPassword ? 'text-green-400' : 'text-red-400'}">\${data.envVars?.hasServerPassword ? '✓ Set' : '✗ Not set'}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-gray-400">OpenCode API Key:</span>
                <span class="\${data.envVars?.hasApiKey ? 'text-green-400' : 'text-red-400'}">\${data.envVars?.hasApiKey ? '✓ Set' : '✗ Not set'}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-gray-400">Git Token:</span>
                <span class="\${data.envVars?.hasGitToken ? 'text-green-400' : 'text-gray-500'}">\${data.envVars?.hasGitToken ? '✓ Set' : '○ Not set'}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-gray-400">Admin Password:</span>
                <span class="\${data.envVars?.hasAdminPassword ? 'text-green-400' : 'text-yellow-400'}">\${data.envVars?.hasAdminPassword ? '✓ Set' : '○ Using server password'}</span>
              </div>
            </div>
          </div>
          
          <div class="bg-gray-900/50 rounded-lg p-4">
            <h3 class="font-medium mb-3 text-gray-300">Git Repositories</h3>
            <div class="text-sm">
              \${data.envVars?.GIT_REPOS ? \`
                <ul class="space-y-1">
                  \${data.envVars.GIT_REPOS.split(',').filter(r => r.trim()).map(repo => \`
                    <li class="text-gray-300 truncate" title="\${repo.trim()}">
                      <span class="text-gray-500">•</span> \${repo.trim().split('/').slice(-1)[0].replace('.git', '') || repo.trim()}
                    </li>
                  \`).join('')}
                </ul>
              \` : '<p class="text-gray-500 italic">No repositories configured</p>'}
            </div>
          </div>
        </div>
        
        <div class="mt-4 bg-gray-900/50 rounded-lg p-4">
          <h3 class="font-medium mb-3 text-gray-300">Model Configuration</h3>
          <div class="text-sm">
            <div class="flex justify-between items-center">
              <span class="text-gray-400">Provider:</span>
              <span class="text-blue-400">OpenCode Zen</span>
            </div>
            <div class="flex justify-between items-center mt-2">
              <span class="text-gray-400">Default Model:</span>
              <span class="font-mono text-xs bg-gray-800 px-2 py-1 rounded">\${data.containerConfig?.model || 'opencode/claude-sonnet-4'}</span>
            </div>
          </div>
        </div>
      \`;
    }
    
    async function startContainer() {
      disableAllButtons();
      showActionResult('Starting container...', 'info');
      const data = await fetchAPI('/start', { method: 'POST' });
      showActionResult(data.message || data.error, !data.error);
      setTimeout(refreshStatus, 2000);
    }
    
    async function stopContainer() {
      disableAllButtons();
      showActionResult('Stopping container...', 'info');
      const data = await fetchAPI('/stop', { method: 'POST' });
      showActionResult(data.message || data.error, !data.error);
      setTimeout(refreshStatus, 2000);
    }
    
    async function restartContainer() {
      disableAllButtons();
      showActionResult('Restarting container (this may take a moment)...', 'info');
      const data = await fetchAPI('/restart', { method: 'POST' });
      showActionResult(data.message || data.error, !data.error);
      setTimeout(refreshStatus, 5000);
    }
    
    function disableAllButtons() {
      document.getElementById('btn-start').disabled = true;
      document.getElementById('btn-stop').disabled = true;
      document.getElementById('btn-restart').disabled = true;
    }
    
    function showActionResult(message, successOrType = true) {
      const resultDiv = document.getElementById('action-result');
      let colorClass = 'text-green-400';
      
      if (successOrType === 'info') {
        colorClass = 'text-blue-400';
      } else if (successOrType === false || successOrType === 'error') {
        colorClass = 'text-red-400';
      }
      
      resultDiv.className = 'mt-4 text-sm ' + colorClass;
      resultDiv.textContent = message;
      
      // Clear message after 10 seconds
      setTimeout(() => {
        if (resultDiv.textContent === message) {
          resultDiv.textContent = '';
        }
      }, 10000);
    }
    
    // Start auto-refresh
    function startAutoRefresh() {
      if (autoRefreshInterval) clearInterval(autoRefreshInterval);
      autoRefreshInterval = setInterval(refreshStatus, 30000); // Every 30 seconds
    }
    
    // Initial load
    refreshStatus();
    refreshConfig();
    startAutoRefresh();
    
    // Refresh on visibility change
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        refreshStatus();
        refreshConfig();
      }
    });
  </script>
</body>
</html>`;
}
