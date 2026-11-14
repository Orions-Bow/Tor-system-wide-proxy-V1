var process = require('process');
var spawn = require('child_process').spawn;
var execFile = require('child_process').execFile;
var execFileSync = require('child_process').execFileSync;
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var net = require('net');
var http = require('http');
// Dependencies are declared in package.json and installed with `npm install`
// into the project-local node_modules directory.
var clc = require('cli-color');
var TorControl = require('tor-control');

var SYSTEM_PROXY_ENABLED = false;
var TOR_SOCKS_PORT = 9050;
var BRIDGE_PORT = 8118;

var REG = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'reg.exe') : 'reg.exe';
var REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
var TOR_DATA = path.join(__dirname, 'tor-data');
var TOR_BIN = path.join(__dirname, 'vendor', 'tor-bundle', 'tor.exe');
var TORRC = path.join(__dirname, 'torrc');
var PASSWORD_FILE = path.join(TOR_DATA, 'control-password.txt');
var PROXY_BACKUP = path.join(TOR_DATA, 'proxy-backup.json');

try { fs.mkdirSync(TOR_DATA, { recursive: true }); } catch (e) {}

// ---------------------------------------------------------------------------
// UI theme: onion art, colours, layout helpers
// ---------------------------------------------------------------------------

var purple = clc.xterm(135);
var green = clc.xterm(40);
var dim = clc.xterm(244);

// "starting" | "connected" | "stopped"
var TOR_STATE = "stopped";

// Raw text + colour. Lines are padded BEFORE colouring so widths line up.
var ART = [
  ["            ,", green],
  ["           /|", green],
  ["          / |", green],
  ["         /  |", green],
  ["      .-'   '-.", purple],
  ["    .'  /| |\\  '.", purple],
  ["   /   / | | \\   \\", purple],
  ["  |   |  | |  |   |", purple],
  ["  |   |  | |  |   |", purple],
  ["   \\   \\ | | /   /", purple],
  ["    '.  \\| |/  .'", purple],
  ["      '-.___.-'", purple],
  ["", purple],
  ["   ~ ~ ~ ~ ~ ~ ~ ~", dim],
  ["", purple],
  ["   system-wide proxy", dim]
];
var ART_WIDTH = 28;

function pad(str, width) {
  while (str.length < width) str += " ";
  return str;
}

function banner(title, colour) {
  var c = colour || clc.blueBright;
  var width = 46;
  var line = " " + new Array(width + 1).join("-") + " ";
  var left = Math.floor((width - title.length) / 2);
  var centred = " " + pad(pad("", left) + title, width) + " ";
  console.log("\n");
  console.log(c(line), "\n");
  console.log(c(centred), "\n");
  console.log(c(line), "\n");
  console.log("\n");
}

function statusLines() {
  var torDot, torText;
  if (TOR_STATE === "connected") { torDot = clc.greenBright("●"); torText = clc.greenBright("connected") + dim("  socks5 :" + TOR_SOCKS_PORT); }
  else if (TOR_STATE === "starting") { torDot = clc.yellowBright("●"); torText = clc.yellowBright("starting..."); }
  else { torDot = clc.redBright("●"); torText = clc.redBright("stopped"); }

  var bridgeUp = bridgeServer && bridgeServer.listening;
  var bridgeDot = bridgeUp ? clc.greenBright("●") : clc.redBright("●");
  var bridgeText = bridgeUp ? clc.greenBright("listening") + dim("  http :" + BRIDGE_PORT) : clc.redBright("down");

  var proxyDot = SYSTEM_PROXY_ENABLED ? clc.greenBright("●") : clc.redBright("●");
  var proxyText = SYSTEM_PROXY_ENABLED ? clc.greenBright("ENABLED") : clc.redBright("DISABLED");

  return [
    " " + torDot + " Tor     " + torText,
    " " + bridgeDot + " Bridge  " + bridgeText,
    " " + proxyDot + " Proxy   " + proxyText
  ];
}

function menuLines() {
  var item = function (n, label, colour) { return " " + clc.whiteBright(n) + dim(" │ ") + (colour || green)(label); };
  var status = statusLines();
  return [
    "",
    " " + clc.whiteBright.bold("T O R   S Y S T E M - W I D E   P R O X Y"),
    " " + dim("────────────────────────────────────────"),
    item("1", "Start TOR connection"),
    item("2", "Log connection info"),
    item("3", "Stop TOR connection"),
    item("4", "Debug TOR connection"),
    item("5", "New TOR identity"),
    item("6", "Restart TOR connection"),
    " " + dim("────────────────────────────────────────"),
    item("7", "ENABLE  system-wide proxy", clc.yellow),
    item("8", "DISABLE system-wide proxy", clc.yellow),
    item("9", "Show system proxy status", clc.yellow),
    " " + dim("────────────────────────────────────────"),
    status[0],
    status[1],
    status[2],
    "",
    " " + clc.whiteBright("Press a number (1-9), Ctrl+C to quit")
  ];
}

// ---------------------------------------------------------------------------
// Registry helpers via execFile — no shell, no metacharacter injection.
// HKCU writes do NOT require admin privileges on Windows.
// ---------------------------------------------------------------------------

function regQuery(valueName) {
  try {
    var out = execFileSync(REG, ['query', REG_KEY, '/v', valueName], { encoding: 'utf8', windowsHide: true });
    var m = out.match(/REG_\S+\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch (e) {
    if (e.status === 1) return null; // value not found
    return undefined; // real error
  }
}

function regSet(valueName, type, data) {
  try {
    execFileSync(REG, ['add', REG_KEY, '/v', valueName, '/t', type, '/d', data, '/f'], { encoding: 'utf8', windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

function regDelete(valueName) {
  try {
    execFileSync(REG, ['delete', REG_KEY, '/v', valueName, '/f'], { encoding: 'utf8', windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Proxy backup / restore — save the user's previous settings before touching
// anything, and put them back on disable/exit (instead of just switching the
// proxy off, which would clobber a corporate or manual proxy configuration).
// ---------------------------------------------------------------------------

function readBackup() {
  try { return JSON.parse(fs.readFileSync(PROXY_BACKUP, 'utf8')); } catch (e) { return null; }
}

function isOurProxy() {
  if (regQuery('ProxyEnable') !== '0x1') return false;
  var server = regQuery('ProxyServer');
  return !!server && server.indexOf('127.0.0.1:' + BRIDGE_PORT) !== -1;
}

function saveProxyBackup() {
  if (isOurProxy()) return;            // never back up our own settings
  if (readBackup()) return;            // keep the original backup
  var backup = {
    ProxyEnable: regQuery('ProxyEnable'),
    ProxyServer: regQuery('ProxyServer'),
    ProxyOverride: regQuery('ProxyOverride')
  };
  try { fs.writeFileSync(PROXY_BACKUP, JSON.stringify(backup), 'utf8'); } catch (e) {}
}

function restoreSystemProxy() {
  var backup = readBackup();
  if (!backup) {
    // No backup on record: only switch off if the proxy points at our bridge
    if (isOurProxy()) regSet('ProxyEnable', 'REG_DWORD', '0');
  } else {
    if (!backup.ProxyEnable || backup.ProxyEnable === '0x0') {
      regSet('ProxyEnable', 'REG_DWORD', '0');
    } else {
      regSet('ProxyEnable', 'REG_DWORD', '1');
    }
    if (backup.ProxyServer) regSet('ProxyServer', 'REG_SZ', backup.ProxyServer);
    else regDelete('ProxyServer');
    if (backup.ProxyOverride) regSet('ProxyOverride', 'REG_SZ', backup.ProxyOverride);
    else regDelete('ProxyOverride');
    try { fs.unlinkSync(PROXY_BACKUP); } catch (e) {}
  }
  SYSTEM_PROXY_ENABLED = false;
}

// ---------------------------------------------------------------------------
// Windows system proxy helpers (HKCU — no admin required)
// ---------------------------------------------------------------------------

function applySystemProxy() {
  if (SYSTEM_PROXY_ENABLED) {
    console.log(clc.yellow("> System proxy is already enabled."));
    return;
  }
  saveProxyBackup(); // remember the user's previous settings for restore
  if (!regSet('ProxyEnable', 'REG_DWORD', '1')) {
    console.log(clc.redBright("> Failed to enable system proxy in registry."));
    return;
  }
  if (!regSet('ProxyServer', 'REG_SZ', 'http=127.0.0.1:' + BRIDGE_PORT + ';https=127.0.0.1:' + BRIDGE_PORT)) {
    console.log(clc.redBright("> Failed to set proxy server."));
    try { restoreSystemProxy(); } catch (e) {} // don't leave it half-applied
    return;
  }
  if (!regSet('ProxyOverride', 'REG_SZ', '<local>')) {
    console.log(clc.redBright("> Failed to set proxy override."));
    try { restoreSystemProxy(); } catch (e) {}
    return;
  }
  SYSTEM_PROXY_ENABLED = true;
  console.log(clc.magentaBright("> System-wide proxy ENABLED: HTTP/HTTPS proxy 127.0.0.1:" + BRIDGE_PORT + " -> Tor SOCKS5"));
  console.log(clc.yellow("> NOTE: You may need to restart your browser/applications for changes to take effect."));
  if (interactive) config.info();
}

// ---------------------------------------------------------------------------
// TCP readiness probe
// ---------------------------------------------------------------------------

function probePort(port, cb) {
  var sock = net.connect(port, '127.0.0.1');
  var done = false;
  function finish(ok) {
    if (done) return;
    done = true;
    sock.destroy();
    cb(ok);
  }
  sock.setTimeout(1500, function () { finish(false); });
  sock.on('connect', function () { finish(true); });
  sock.on('error', function () { finish(false); });
}

// Refuse to enable the system proxy unless Tor and the bridge are listening,
// otherwise every website would hang/fail.
function enableSystemProxy() {
  probePort(TOR_SOCKS_PORT, function (torOk) {
    if (!torOk) {
      console.log(clc.redBright("> Tor is not running (nothing listening on 127.0.0.1:" + TOR_SOCKS_PORT + ")."));
      console.log(clc.yellow("> Start Tor first (option 1 / 'start') and wait for 100%, then enable the proxy."));
      return;
    }
    probePort(BRIDGE_PORT, function (bridgeOk) {
      if (!bridgeOk) {
        console.log(clc.redBright("> The HTTP bridge is not running on 127.0.0.1:" + BRIDGE_PORT + "."));
        console.log(clc.yellow("> The bridge starts together with Tor. Start Tor with 'start' (option 1) from this tool and keep it open."));
        return;
      }
      applySystemProxy();
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP -> SOCKS5 bridge (Windows' system proxy cannot use SOCKS directly).
// Accepts HTTP proxy requests and CONNECT tunnels on 127.0.0.1:8118 and
// forwards them through Tor's SOCKS5 port. Hostnames are passed to Tor
// unresolved, so DNS is resolved by Tor (no leaks).
// ---------------------------------------------------------------------------

function socks5Connect(host, port, cb) {
  if (!host || host.length > 255 || port < 1 || port > 65535) {
    return cb(new Error('Invalid host or port'));
  }
  var sock = net.connect(TOR_SOCKS_PORT, '127.0.0.1');
  var stage = 0;
  var buf = Buffer.alloc(0);
  var finished = false;

  function fail(err) {
    if (finished) return;
    finished = true;
    sock.destroy();
    cb(err);
  }

  sock.setTimeout(30000, function () { fail(new Error('SOCKS timeout')); });
  sock.on('error', fail);
  sock.on('close', function () { fail(new Error('SOCKS closed')); });

  sock.on('connect', function () {
    sock.write(Buffer.from([5, 1, 0]));
  });

  sock.on('data', function onData(chunk) {
    if (finished) return;
    buf = Buffer.concat([buf, chunk]);

    if (stage === 0) {
      if (buf.length < 2) return;
      if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('SOCKS auth rejected'));
      buf = buf.slice(2);
      stage = 1;
      var hostBuf = Buffer.from(host);
      var req = Buffer.alloc(7 + hostBuf.length);
      req[0] = 5; req[1] = 1; req[2] = 0; req[3] = 3; req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(port, 5 + hostBuf.length);
      sock.write(req);
    }

    if (stage === 1) {
      if (buf.length < 5) return;
      if (buf[1] !== 0) return fail(new Error('SOCKS connect failed (code ' + buf[1] + ')'));
      var atyp = buf[3];
      var total = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buf[4];
      if (buf.length < total) return;
      var rest = buf.slice(total);
      finished = true;
      sock.removeListener('data', onData);
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      sock.setTimeout(0);
      if (rest.length) sock.unshift(rest);
      cb(null, sock);
    }
  });
}

var bridgeServer = null;

function startBridge() {
  if (bridgeServer) return;
  bridgeServer = http.createServer({ maxConnections: 128 }, function (req, res) {
    req.setTimeout(120000, function () { req.destroy(); });
    var target;
    try { target = new URL(req.url); } catch (e) {
      res.writeHead(400); return res.end('Bad proxy request');
    }
    var port = parseInt(target.port, 10) || 80;
    socks5Connect(target.hostname, port, function (err, upstream) {
      if (err) { res.writeHead(502); return res.end('Tor error: ' + err.message); }
      var headers = Object.assign({}, req.headers);
      delete headers['proxy-connection'];
      var preq = http.request({
        createConnection: function () { return upstream; },
        method: req.method,
        path: target.pathname + target.search,
        headers: headers
      }, function (pres) {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
      });
      preq.on('error', function () { res.writeHead(502); res.end('Upstream error'); });
      req.pipe(preq);
    });
  });

  bridgeServer.on('connect', function (req, client, head) {
    client.setTimeout(120000, function () { client.destroy(); });
    var idx = req.url.lastIndexOf(':');
    var host = req.url.slice(0, idx).replace(/^\[|\]$/g, '');
    var port = parseInt(req.url.slice(idx + 1), 10) || 443;
    client.on('error', function () {});
    socks5Connect(host, port, function (err, upstream) {
      if (err) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      upstream.on('error', function () { client.destroy(); });
      client.on('close', function () { upstream.destroy(); });
    });
  });

  bridgeServer.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      console.log(clc.yellow("> Port " + BRIDGE_PORT + " already in use - assuming a bridge is already running."));
    } else {
      console.log(clc.redBright("> Bridge error: " + err.message));
    }
    bridgeServer = null;
  });

  bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', function () {
    console.log(clc.cyan("> HTTP bridge listening on 127.0.0.1:" + BRIDGE_PORT + " -> Tor SOCKS5 127.0.0.1:" + TOR_SOCKS_PORT));
  });
}

function disableSystemProxy() {
  try {
    restoreSystemProxy();
    console.log(clc.magentaBright("> System-wide proxy DISABLED. Previous proxy settings restored."));
  } catch (e) {
    console.log(clc.redBright("> Failed to disable system proxy in registry."));
  }
  if (interactive) config.info();
}

function showSystemProxyStatus() {
  var enabled = regQuery('ProxyEnable');
  if (enabled === undefined) {
    console.log(clc.yellow("> Could not read proxy status from registry."));
    return;
  }
  SYSTEM_PROXY_ENABLED = enabled === '0x1';
  if (SYSTEM_PROXY_ENABLED) {
    var server = regQuery('ProxyServer') || 'unknown';
    console.log(clc.cyan("> System proxy: ENABLED  => " + server));
  } else {
    console.log(clc.cyan("> System proxy: DISABLED"));
  }
  if (interactive) config.info();
}

// ---------------------------------------------------------------------------
// Tor connection manager (enhanced with system-wide proxy controls)
// ---------------------------------------------------------------------------

function getControlPassword() {
  try { return fs.readFileSync(PASSWORD_FILE, 'utf8').trim(); } catch (e) { return ''; }
}

function generateControlPassword() {
  var pw = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(PASSWORD_FILE, pw, 'utf8'); } catch (e) {}
  return pw;
}

var torChild = null;
var interactive = false;

// Restore proxy settings on exit to prevent stale proxy settings
function cleanupOnExit() {
  if (SYSTEM_PROXY_ENABLED) {
    try { restoreSystemProxy(); } catch (e) {}
  }
  if (torChild && !torChild.killed) {
    try { torChild.kill(); } catch (e) {}
  }
}

process.on('exit', cleanupOnExit);
process.on('SIGINT', function () { cleanupOnExit(); process.exit(0); });
process.on('SIGTERM', function () { cleanupOnExit(); process.exit(0); });

var config = {
  "info": function () {
    var menu = menuLines();
    var rows = Math.max(ART.length, menu.length);
    console.log("\n\n");
    for (var i = 0; i < rows; i++) {
      var art = ART[i] || ["", dim];
      var left = art[1](pad(art[0], ART_WIDTH));
      console.log("  " + left + (menu[i] || ""));
    }
    console.log("\n");
  },
  "start": function () {
    banner("Start Tor Connection");
    // Generate a random control password and get its Tor hash.
    // NOTE: tor --hash-password also prints startup notices to stdout,
    // so we must pick out the actual "16:..." hash line.
    var pw = generateControlPassword();
    var pwHash;
    try {
      var hashOut = execFileSync(TOR_BIN, ['--hash-password', pw], { encoding: 'utf8', windowsHide: true });
      pwHash = hashOut.split('\n').map(function (s) { return s.trim(); })
        .filter(function (s) { return s.indexOf('16:') === 0; })[0];
      if (!pwHash) throw new Error('no hash line in tor output');
    } catch (e) {
      console.log(clc.redBright("> Failed to hash control password: " + e.message));
      return;
    }
    startBridge();
    TOR_STATE = "starting";
    torChild = spawn(TOR_BIN, ["-f", TORRC, "--DataDirectory", TOR_DATA, "--HashedControlPassword", pwHash]);
    torChild.on('exit', (code) => {
      console.log(clc.redBright("Tor exited with code " + code));
      TOR_STATE = "stopped";
      // Restore settings if Tor died — don't leave the system pointing at a dead bridge
      if (SYSTEM_PROXY_ENABLED) {
        console.log(clc.yellow("> Tor stopped — restoring previous proxy settings to restore connectivity."));
        try { restoreSystemProxy(); } catch (e) {}
      }
      torChild = null;
      if (interactive) config.info();
    });
    torChild.stdout.on('data', (data) => {
      console.log(clc.green(data.toString()));
      if (data.toString().indexOf("100%:") !== -1) {
        TOR_STATE = "connected";
        console.log("\n");
        console.log(clc.magentaBright("--- Tor is connected successfully! ---"));
        console.log(clc.cyan("    SOCKS5 proxy    : 127.0.0.1:" + TOR_SOCKS_PORT));
        console.log(clc.cyan("    HTTP bridge     : 127.0.0.1:" + BRIDGE_PORT));
        console.log(clc.cyan("    Control port    : 127.0.0.1:9051 (password-protected)"));
        console.log("\n");
        config.info();
      }
    });
    torChild.stderr.on('data', (data) => {console.log(clc.redBright(data.toString()))});
  },
  "new": function () {
    banner("Switch to clean circuits");
    var control = new TorControl({ host: '127.0.0.1', password: getControlPassword() });
    control.signalNewnym(function (error, status) {
      if (error) return console.log(clc.redBright("> error: "), clc.redBright(error));
      else console.log(clc.greenBright("> status: "), clc.greenBright(status.messages[0]));
      config.info();
    });
  },
  "close": function () {
    banner("Tor Shutdown");
    if (SYSTEM_PROXY_ENABLED) {
      console.log(clc.yellow("> WARNING: System proxy is still ENABLED. Traffic will fail once Tor stops."));
      console.log(clc.yellow("> Use option 8 to disable it, or option 9 to check status."));
      console.log("\n");
    }
    var control = new TorControl({ host: '127.0.0.1', password: getControlPassword() });
    control.signalHalt(function (error, status) {
      if (error) return console.log(clc.redBright("> error: "), clc.redBright(error));
      else console.log(clc.greenBright("> status: "), clc.greenBright(status.messages[0]));
      config.info();
    });
  },
  "log": function () {
    banner("Log Information");
    var control = new TorControl({ host: '127.0.0.1', password: getControlPassword() });
    control.signalDump(function (error, status) {
      if (error) return console.log(clc.redBright("> error: "), clc.redBright(error));
      else console.log(clc.greenBright("> status: "), clc.greenBright(status.messages[0]));
      config.info();
    });
  },
  "debug": function () {
    banner("Debug");
    var control = new TorControl({ host: '127.0.0.1', password: getControlPassword() });
    control.signalDebug(function (error, status) {
      if (error) return console.log(clc.redBright("> error: "), clc.redBright(error));
      else console.log(clc.greenBright("> status: "), clc.greenBright(status.messages[0]));
      config.info();
    });
  },
  "restart": function () {
    banner("Restart");
    var control = new TorControl({ host: '127.0.0.1', password: getControlPassword() });
    control.signalHalt(function (error, status) {
      if (error) return console.log(clc.redBright("> error: "), clc.redBright(error));
      else config.start();
    });
  }
};

// ===========================================================================
// CLI help
// ===========================================================================

function printHelp() {
  console.log("");
  console.log(clc.white("  TOR System-Wide Proxy  --  CLI Reference"));
  console.log(clc.white("  ========================================="));
  console.log("");
  console.log(clc.cyan("  node run.js start              ") + "Start the Tor SOCKS5 proxy and stay attached");
  console.log(clc.cyan("  node run.js stop               ") + "Shut down the running Tor process");
  console.log(clc.cyan("  node run.js restart            ") + "Stop and then re-start Tor");
  console.log(clc.cyan("  node run.js newnym             ") + "Request clean circuits (new identity)");
  console.log(clc.cyan("  node run.js logs               ") + "Dump Tor log information");
  console.log(clc.cyan("  node run.js debug              ") + "Send DEBUG signal to Tor");
  console.log("");
  console.log(clc.yellow("  node run.js proxy-on           ") + "Route all Windows system traffic through Tor");
  console.log(clc.yellow("  node run.js proxy-off          ") + "Restore direct system connection");
  console.log(clc.yellow("  node run.js status             ") + "Show current system proxy status");
  console.log("");
  console.log(clc.white("  node run.js help               ") + "Show this help");
  console.log(clc.white("  node run.js                    ") + "(no args) Launch interactive menu");
  console.log("");
}

// ===========================================================================
// CLI dispatch
// ===========================================================================

var args = process.argv.slice(2);
var cmd = args[0] ? args[0].toLowerCase() : '';

if (cmd) {
  // ---- Non-interactive CLI mode ----
  switch (cmd) {
    case 'start':
      console.log(clc.blueBright("Starting Tor ... (press Ctrl+C to stop)"));
      config.start();
      break;

    case 'stop':
      console.log(clc.blueBright("Shutting down Tor ..."));
      config.close();
      // close is async; after 3 s force-exit in case tor-control can't reach the port
      setTimeout(function () { process.exit(0); }, 3000);
      break;

    case 'restart':
      console.log(clc.blueBright("Restarting Tor ..."));
      config.restart();
      break;

    case 'newnym':
    case 'new-identity':
    case 'new':
      console.log(clc.blueBright("Requesting new Tor identity ..."));
      config.new();
      setTimeout(function () { process.exit(0); }, 3000);
      break;

    case 'logs':
    case 'log':
      console.log(clc.blueBright("Dumping Tor logs ..."));
      config.log();
      setTimeout(function () { process.exit(0); }, 3000);
      break;

    case 'debug':
      console.log(clc.blueBright("Sending DEBUG signal ..."));
      config.debug();
      setTimeout(function () { process.exit(0); }, 3000);
      break;

    case 'proxy-on':
      console.log(clc.blueBright("Enabling system-wide proxy ..."));
      enableSystemProxy();
      setTimeout(function () { process.exit(0); }, 6000);
      break;

    case 'proxy-off':
      console.log(clc.blueBright("Disabling system-wide proxy ..."));
      disableSystemProxy();
      setTimeout(function () { process.exit(0); }, 2000);
      break;

    case 'status':
    case 'proxy-status':
      showSystemProxyStatus();
      setTimeout(function () { process.exit(0); }, 2000);
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
      break;

    default:
      console.log(clc.redBright("Unknown command: " + cmd));
      console.log(clc.yellow("Run 'node run.js help' for available commands."));
      process.exit(1);
  }

} else {
  // ---- Interactive mode (no CLI args) ----
  interactive = true;
  var stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  stdin.on('data', function (e) {
    if (e === '1') config.start();
    if (e === '2') config.log();
    if (e === '3') config.close();
    if (e === '4') config.debug();
    if (e === '5') config.new();
    if (e === '6') config.restart();
    if (e === '7') enableSystemProxy();
    if (e === '8') disableSystemProxy();
    if (e === '9') showSystemProxyStatus();
    if (e === '\u0003') {
      if (SYSTEM_PROXY_ENABLED) {
        console.log(clc.yellow("\n> System proxy is still ENABLED. Disabling before exit..."));
        disableSystemProxy();
      }
      setTimeout(function () { process.exit(); }, 500);
    }
  });

  // Sync real registry state first, then draw the menu once
  interactive = false;
  showSystemProxyStatus();
  interactive = true;
  config.info();
}