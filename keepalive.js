const http = require("http");
const fs = require("fs");

const LOG = "/tmp/opencode.log";

function readLog() {
  try {
    return fs.readFileSync(LOG, "utf8");
  } catch (e) {
    return "no log: " + String(e);
  }
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/global/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ healthy: false, crash: true }));
    return;
  }
  if (url === "/__opencode-log") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(readLog());
    return;
  }
  res.writeHead(503, { "Content-Type": "text/plain" });
  res.end("opencode crashed; see /__opencode-log");
});

server.listen(4096, "0.0.0.0", () => {
  try {
    fs.appendFileSync(LOG, "keep-alive listening on 4096\n");
  } catch (_) {}
});

// Stay alive
setInterval(() => {}, 1 << 30);
