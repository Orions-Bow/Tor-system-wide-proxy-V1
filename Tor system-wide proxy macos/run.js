var process = require('process');
var spawn = require('child_process').spawn;
var execFileSync = require('child_process').execFileSync;
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var net = require('net');

// Dependencies are declared in package.json and installed with `npm install`
// into the project-local node_modules directory.
var clc = require('cli-color');
var TorControl = require('tor-control');

var SYSTEM_PROXY_ENABLED = false;
var PROXIED_SERVICES = [];
var TOR_SOCKS_HOST = '127.0.0.1';
var TOR_SOCKS_PORT = 9050;

var NETWORKSETUP = '/usr/sbin/networksetup';
var SCRIPT = path.basename(__filename);
var TOR_DATA = path.join(__dirname, 'tor-data');
var TORRC = path.join(__dirname, 'torrc');
var PASSWORD_FILE = path.join(TOR_DATA, 'control-password.txt');
var PROXY_BACKUP = path.join(TOR_DATA, 'system-proxy-backup.json');

try { fs.mkdirSync(TOR_DATA, { recursive: true, mode: 448 }); } catch (e) {}

// ---------------------------------------------------------------------------
// Locate the tor binary: $TOR_BIN, Homebrew (Apple Silicon / Intel), then
// whatever `which tor` finds on PATH.
// ---------------------------------------------------------------------------

function findTor() {
  var candidates = [
    process.env.TOR_BIN,
    '/opt/homebrew/bin/tor',
    '/usr/local/bin/tor'
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  try {
    var w = execFileSync('/usr/bin/which', ['tor'], { encoding: 'utf8' }).trim();
    if (w) return w;
  } catch (e) {}
  return null;
}

var TOR_BIN = findTor();

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
  ["   macOS system proxy", dim]
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

  var proxyDot = SYSTEM_PROXY_ENABLED ? clc.greenBright("●") : clc.redBright("●");
  var proxyText = SYSTEM_PROXY_ENABLED
    ? clc.greenBright("ENABLED") + dim("  " + PROXIED_SERVICES.length + " network service" + (PROXIED_SERVICES.length === 1 ? "" : "s"))
    : clc.redBright("DISABLED");

  var routeDot = SYSTEM_PROXY_ENABLED ? clc.greenBright("●") : dim("●");
  var routeText = SYSTEM_PROXY_ENABLED
    ? clc.cyan("system -> socks5 " + TOR_SOCKS_HOST + ":" + TOR_SOCKS_PORT)
    : dim("direct connection");

  return [
    " " + torDot + " Tor     " + torText,
    " " + proxyDot + " Proxy   " + proxyText,
    " " + routeDot + " Route   " + routeText
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
// macOS network helpers (networksetup, no shell involved).
// macOS supports a SOCKS proxy natively, so unlike Windows we point the
// system straight at Tor's SOCKS5 port - no HTTP bridge required, and
// hostnames are handed to Tor so DNS is resolved by Tor.
// ---------------------------------------------------------------------------

function ns(args) {
  return execFileSync(NETWORKSETUP, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Write operations need admin rights. Instead of running the whole tool as
// root, each change goes through "sudo -n" (non-interactive). If no cached
// credentials exist this throws and permissionHint() tells the user to run
// "sudo -v" first.
function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function nsWrite(args) {
  if (isRoot()) return ns(args);
  return execFileSync('/usr/bin/sudo', ['-n', NETWORKSETUP].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Enabled network services only (disabled ones are prefixed with '*')
function listServices() {
  return ns(['-listallnetworkservices'])
    .split('\n').slice(1)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.charAt(0) !== '*'; });
}

function getSocks(service) {
  var out = ns(['-getsocksfirewallproxy', service]);
  function field(k) {
    // [ \t]* not \s* — \s would cross the newline on empty values and
    // capture the next line (e.g. "Port: 0") as this field's value.
    var m = out.match(new RegExp('^' + k + ':[ \\t]*(.*)$', 'm'));
    return m ? m[1].trim() : '';
  }
  return { enabled: field('Enabled').toLowerCase() === 'yes', server: field('Server'), port: field('Port') };
}

function isOurs(s) {
  return s.enabled && s.server === TOR_SOCKS_HOST && s.port === String(TOR_SOCKS_PORT);
}

function readBackup() {
  try { return JSON.parse(fs.readFileSync(PROXY_BACKUP, 'utf8')); } catch (e) { return {}; }
}

function permissionHint(e) {
  var msg = ((e.stderr || '') + (e.message || '')).toString();
  if (/privilege|admin|authoriz|permission|not allowed|sudo/i.test(msg)) {
    console.log(clc.yellow("> Admin rights are needed for proxy changes. Run \"sudo -v\" first to cache"));
    console.log(clc.yellow(">  your credentials, then try again. (No need to run this tool as root.)"));
  }
}

// Throws on failure. Saves previous SOCKS settings so they can be restored.
function applySystemProxy() {
  if (SYSTEM_PROXY_ENABLED) {
    console.log(clc.yellow("> System proxy is already enabled."));
    return;
  }
  try {
    var services = listServices();
    if (!services.length) throw new Error("no active network services found");

    var backup = readBackup();
    services.forEach(function (svc) {
      var cur = getSocks(svc);
      if (!backup[svc] && !isOurs(cur)) backup[svc] = cur;
    });
    fs.writeFileSync(PROXY_BACKUP, JSON.stringify(backup), { mode: 384 });

    services.forEach(function (svc) {
      nsWrite(['-setsocksfirewallproxy', svc, TOR_SOCKS_HOST, String(TOR_SOCKS_PORT)]);
      nsWrite(['-setsocksfirewallproxystate', svc, 'on']);
    });

    PROXIED_SERVICES = services;
    SYSTEM_PROXY_ENABLED = true;
    console.log(clc.magentaBright("> System-wide proxy ENABLED: SOCKS5 " + TOR_SOCKS_HOST + ":" + TOR_SOCKS_PORT + " on " + services.join(", ")));
    console.log(clc.yellow("> NOTE: Some apps cache proxy settings - restart them if they still connect directly."));
  } catch (e) {
    console.log(clc.redBright("> Failed to enable system proxy: " + String(e.message).split("\n")[0]));
    permissionHint(e);
    try { restoreSystemProxy(); } catch (e2) {} // don't leave it half-applied
  }
  if (interactive) config.info();
}

// Puts each network service back how it was before we touched it.
// Throws on failure (callers decide how loud to be).
function restoreSystemProxy() {
  var backup = readBackup();
  listServices().forEach(function (svc) {
    var prev = backup[svc];
    var cur = getSocks(svc);
    if (!prev && !isOurs(cur)) return; // not ours, leave alone
    if (prev && prev.server && prev.port && prev.port !== '0') {
      nsWrite(['-setsocksfirewallproxy', svc, prev.server, prev.port]);
    }
    nsWrite(['-setsocksfirewallproxystate', svc, prev && prev.enabled ? 'on' : 'off']);
  });
  try { fs.unlinkSync(PROXY_BACKUP); } catch (e) {}
  PROXIED_SERVICES = [];
  SYSTEM_PROXY_ENABLED = false;
}

// ---------------------------------------------------------------------------
// TCP readiness probe
// ---------------------------------------------------------------------------

function probePort(port, cb) {
  var sock = net.connect(port, TOR_SOCKS_HOST);
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

// Refuse to enable the system proxy unless Tor is listening,
// otherwise every website would hang/fail.
function enableSystemProxy() {
  probePort(TOR_SOCKS_PORT, function (torOk) {
    if (!torOk) {
      console.log(clc.redBright("> Tor is not running (nothing listening on " + TOR_SOCKS_HOST + ":" + TOR_SOCKS_PORT + ")."));
      console.log(clc.yellow("> Start Tor first (option 1 / 'start') and wait for 100%, then enable the proxy."));
      return;
    }
    applySystemProxy();
  });
}

function disableSystemProxy() {
  try {
    restoreSystemProxy();
    console.log(clc.magentaBright("> System-wide proxy DISABLED. Traffic returns to direct connection."));
  } catch (e) {
    console.log(clc.redBright("> Failed to disable system proxy: " + String(e.message).split("\n")[0]));
    permissionHint(e);
  }
  if (interactive) config.info();
}

function showSystemProxyStatus() {
  try {
    var ours = listServices().filter(function (svc) { return isOurs(getSocks(svc)); });
    PROXIED_SERVICES = ours;
    SYSTEM_PROXY_ENABLED = ours.length > 0;
    if (SYSTEM_PROXY_ENABLED) {
      console.log(clc.cyan("> System proxy: ENABLED  => socks5 " + TOR_SOCKS_HOST + ":" + TOR_SOCKS_PORT + " (" + ours.join(", ") + ")"));
    } else {
      console.log(clc.cyan("> System proxy: DISABLED"));
    }
  } catch (e) {
    console.log(clc.yellow("> Could not read proxy status from macOS."));
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
  try { fs.writeFileSync(PASSWORD_FILE, pw, { encoding: 'utf8', mode: 384 }); } catch (e) {}
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
process.on('SIGHUP', function () { cleanupOnExit(); process.exit(0); }); // terminal window closed

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
    if (!TOR_BIN) {
      console.log(clc.redBright("> Could not find the tor binary."));
      console.log(clc.yellow("> Install it with:  brew install tor   (or set TOR_BIN=/path/to/tor)"));
      return;
    }
    if (torChild) {
      console.log(clc.yellow("> Tor is already running."));
      return;
    }
    // Generate a random control password and get its Tor hash.
    // NOTE: tor --hash-password also prints startup notices to stdout,
    // so we must pick out the actual "16:..." hash line.
    var pw = generateControlPassword();
    var pwHash;
    try {
      var hashOut = execFileSync(TOR_BIN, ['--hash-password', pw], { encoding: 'utf8' });
      pwHash = hashOut.split('\n').map(function (s) { return s.trim(); })
        .filter(function (s) { return s.indexOf('16:') === 0; })[0];
      if (!pwHash) throw new Error('no hash line in tor output');
    } catch (e) {
      console.log(clc.redBright("> Failed to hash control password: " + e.message));
      return;
    }
    TOR_STATE = "starting";
    torChild = spawn(TOR_BIN, ["-f", TORRC, "--DataDirectory", TOR_DATA, "--HashedControlPassword", pwHash]);
    torChild.on('error', (err) => {
      console.log(clc.redBright("> Failed to launch tor: " + err.message));
      TOR_STATE = "stopped";
      torChild = null;
    });
    torChild.on('exit', (code) => {
      console.log(clc.redBright("Tor exited with code " + code));
      TOR_STATE = "stopped";
      // Restore settings if Tor died — don't leave the system pointing at a dead proxy
      if (SYSTEM_PROXY_ENABLED) {
        console.log(clc.yellow("> Tor stopped — disabling system proxy to restore connectivity."));
        try { restoreSystemProxy(); } catch (e) {
          console.log(clc.redBright("> Could not restore proxy settings: " + String(e.message).split("\n")[0]));
        }
      }
      torChild = null;
      if (interactive) config.info();
    });
    torChild.stdout.on('data', (data) => {
      console.log(clc.green(data.toString()));
      if (data.toString().indexOf("100%") !== -1) {
        TOR_STATE = "connected";
        console.log("\n");
        console.log(clc.magentaBright("--- Tor is connected successfully! ---"));
        console.log(clc.cyan("    SOCKS5 proxy    : " + TOR_SOCKS_HOST + ":" + TOR_SOCKS_PORT));
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
  var cmdPad = function (s) { return pad("  node " + SCRIPT + " " + s, 34); };
  console.log("");
  console.log(clc.white("  TOR System-Wide Proxy (macOS)  --  CLI Reference"));
  console.log(clc.white("  ================================================="));
  console.log("");
  console.log(clc.cyan(cmdPad("start")) + "Start the Tor SOCKS5 proxy and stay attached");
  console.log(clc.cyan(cmdPad("stop")) + "Shut down the running Tor process");
  console.log(clc.cyan(cmdPad("restart")) + "Stop and then re-start Tor");
  console.log(clc.cyan(cmdPad("newnym")) + "Request clean circuits (new identity)");
  console.log(clc.cyan(cmdPad("logs")) + "Dump Tor log information");
  console.log(clc.cyan(cmdPad("debug")) + "Send DEBUG signal to Tor");
  console.log("");
  console.log(clc.yellow(cmdPad("proxy-on")) + "Route all macOS network traffic through Tor");
  console.log(clc.yellow(cmdPad("proxy-off")) + "Restore previous proxy settings");
  console.log(clc.yellow(cmdPad("status")) + "Show current system proxy status");
  console.log("");
  console.log(clc.white(cmdPad("help")) + "Show this help");
  console.log(clc.white(cmdPad("")) + "(no args) Launch interactive menu");
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
      // One-shot invocation: the proxy must outlive this process, so skip the exit restore
      process.removeAllListeners('exit');
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
      console.log(clc.yellow("Run 'node " + SCRIPT + " help' for available commands."));
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

  // Sync real system state first, then draw the menu once
  interactive = false;
  showSystemProxyStatus();
  interactive = true;
  config.info();
}
