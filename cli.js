#!/usr/bin/env node
'use strict';

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execSync } = require('child_process');

const MCP_NAME  = 'agillic-docs';
const MCP_URL   = 'https://agimcp.dwarf.dk/mcp';
const MCP_ENTRY = { type: 'http', url: MCP_URL };

const home     = os.homedir();
const platform = process.platform;
const isTTY    = !!(process.stdout.isTTY && process.stdin.isTTY);

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  white:  s => `\x1b[97m${s}\x1b[0m`,
};

const out   = s => process.stdout.write(s);
const print = s => out(s + '\n');

const ansi = {
  hideCursor: () => isTTY && out('\x1b[?25l'),
  showCursor: () => isTTY && out('\x1b[?25h'),
  upAndClear: n  => n > 0 && out(`\x1b[${n}A\x1b[J`),
  clearLine:  () => out('\r\x1b[2K'),
};

const shortPath = p => p ? p.replace(home, '~') : '';
const sleep     = ms => new Promise(r => setTimeout(r, ms));

// ─── Spinner ──────────────────────────────────────────────────────────────────

const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

class Spinner {
  constructor(text) { this.text = text; this.i = 0; this.timer = null; }

  start() {
    if (!isTTY) return this;
    ansi.hideCursor();
    this.timer = setInterval(() =>
      out(`\r  ${c.cyan(FRAMES[this.i++ % FRAMES.length])}  ${this.text}`), 80);
    return this;
  }

  stop(icon, text) {
    if (!isTTY) {
      if (icon != null) print(`  ${icon}  ${text}`);
      return;
    }
    clearInterval(this.timer);
    ansi.clearLine();
    if (icon != null) out(`  ${icon}  ${text}\n`);
    ansi.showCursor();
  }

  succeed(text) { this.stop(c.green('✓'), text ?? this.text); }
  fail(text)    { this.stop(c.red('✗'),   text ?? this.text); }
  clear()       { this.stop(null, null); }
}

// ─── Prompt engine ────────────────────────────────────────────────────────────

function listenKeys(handler) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', handler);
  return () => {
    process.stdin.removeListener('data', handler);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  };
}

function abort() {
  ansi.showCursor();
  print(`\n  ${c.dim('Cancelled.')}\n`);
  process.exit(0);
}

// Arrow-key radio. Returns index of chosen option.
function radioPrompt(label, options, defaultIdx = 0) {
  if (!isTTY) return Promise.resolve(defaultIdx);
  return new Promise(resolve => {
    let cur = defaultIdx;
    let rendered = 0;

    const render = () => {
      ansi.upAndClear(rendered);
      const lines = [
        `  ${c.dim('┌')}  ${label}`,
        `  ${c.dim('│')}`,
        ...options.map((opt, i) => {
          const focused = i === cur;
          const icon    = focused ? c.cyan('◉') : c.dim('○');
          const text    = focused ? c.white(c.bold(opt)) : c.dim(opt);
          return `  ${c.dim('│')}  ${icon}  ${text}`;
        }),
        `  ${c.dim('│')}`,
        `  ${c.dim('└')}  ${c.dim('↑↓ move   enter confirm')}`,
      ];
      out(lines.join('\n') + '\n');
      rendered = lines.length;
    };

    ansi.hideCursor();
    render();

    const stop = listenKeys(key => {
      if      (key === '\u001b[A' || key === 'k') cur = Math.max(0, cur - 1);
      else if (key === '\u001b[B' || key === 'j') cur = Math.min(options.length - 1, cur + 1);
      else if (key === '\r' || key === '\n')  { stop(); ansi.upAndClear(rendered); ansi.showCursor(); resolve(cur); return; }
      else if (key === 'q' || key === '\u0003') { stop(); abort(); return; }
      render();
    });
  });
}

// Arrow-key checkbox. Returns array of selected indices (non-disabled).
function checkboxPrompt(label, items) {
  if (!isTTY) {
    return Promise.resolve(items.map((it, i) => i).filter(i => !items[i].disabled));
  }
  return new Promise(resolve => {
    const selected = new Set(items.map((it, i) => it.disabled ? -1 : i).filter(i => i >= 0));
    let cur = 0;
    let rendered = 0;

    const render = () => {
      ansi.upAndClear(rendered);
      const lines = [
        `  ${c.dim('┌')}  ${label}`,
        `  ${c.dim('│')}`,
        ...items.map((it, i) => {
          const focused = i === cur;
          const sel     = selected.has(i);
          const icon    = it.disabled ? c.dim('─')
                        : sel && focused ? c.cyan('◆')
                        : sel            ? c.green('◆')
                        : focused        ? c.cyan('◇')
                        :                  c.dim('◇');
          const label_  = it.disabled ? c.dim(it.label)
                        : focused     ? c.white(c.bold(it.label))
                        :               it.label;
          const hint    = it.hint    ? c.dim(`  ${it.hint}`) : '';
          const skip    = it.disabled ? c.dim('  installed') : '';
          const warn    = it.warning  ? `  ${c.yellow('⚠  ' + it.warning)}` : '';
          return `  ${c.dim('│')}  ${icon}  ${label_}${hint}${skip}${warn}`;
        }),
        `  ${c.dim('│')}`,
        `  ${c.dim('└')}  ${c.dim('↑↓ move   space toggle   a select all   enter install   q quit')}`,
      ];
      out(lines.join('\n') + '\n');
      rendered = lines.length;
    };

    ansi.hideCursor();
    render();

    const stop = listenKeys(key => {
      if      (key === '\u001b[A' || key === 'k') cur = Math.max(0, cur - 1);
      else if (key === '\u001b[B' || key === 'j') cur = Math.min(items.length - 1, cur + 1);
      else if (key === ' ') {
        if (!items[cur].disabled) {
          if (selected.has(cur)) selected.delete(cur);
          else selected.add(cur);
        }
      }
      else if (key === 'a' || key === 'A') {
        const all = items.map((it, i) => i).filter(i => !items[i].disabled);
        if (all.every(i => selected.has(i))) all.forEach(i => selected.delete(i));
        else all.forEach(i => selected.add(i));
      }
      else if (key === '\r' || key === '\n')  { stop(); ansi.upAndClear(rendered); ansi.showCursor(); resolve([...selected]); return; }
      else if (key === 'q' || key === '\u0003') { stop(); abort(); return; }
      render();
    });
  });
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function claudeDesktopConfigPath() {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32')  return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

function vscodeUserSettingsPath() {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  if (platform === 'win32')  return path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
  return path.join(home, '.config', 'Code', 'User', 'settings.json');
}

function commandExists(cmd) {
  try {
    execSync(platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function semverGte(v, min) {
  const p = s => s.split('.').map(n => parseInt(n) || 0);
  const [a, b] = [p(v), p(min)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i]||0) > (b[i]||0)) return true;
    if ((a[i]||0) < (b[i]||0)) return false;
  }
  return true;
}

function getClaudeDesktopVersion() {
  try {
    if (platform === 'darwin') {
      const plist = '/Applications/Claude.app/Contents/Info.plist';
      if (fs.existsSync(plist))
        return execSync(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${plist}"`,
          { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
    }
  } catch {}
  return null;
}

function getVSCodeVersion() {
  try {
    return execSync('code --version', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split('\n')[0] || null;
  } catch {}
  return null;
}

// ─── Client detection ─────────────────────────────────────────────────────────

function detectClients() {
  const found = [];

  if (fs.existsSync(path.join(home, '.claude'))) {
    found.push({
      id: 'claude-code', name: 'Claude Code', scopeable: false,
      globalConfigPath: path.join(home, '.claude', 'settings.json'),
      localConfigPath: null, keyPath: ['mcpServers'],
    });
  }

  const desktopPath = claudeDesktopConfigPath();
  if (fs.existsSync(desktopPath)) {
    const version = getClaudeDesktopVersion();
    found.push({
      id: 'claude-desktop', name: 'Claude Desktop', scopeable: false,
      globalConfigPath: desktopPath, localConfigPath: null, keyPath: ['mcpServers'],
      version,
      warning: version && !semverGte(version, '0.9.0') ? 'HTTP MCPs require v0.9+' : null,
    });
  }

  if (fs.existsSync(path.join(home, '.cursor'))) {
    found.push({
      id: 'cursor', name: 'Cursor', scopeable: true,
      globalConfigPath: path.join(home, '.cursor', 'mcp.json'),
      localConfigPath: path.join(process.cwd(), '.cursor', 'mcp.json'),
      keyPath: ['mcpServers'],
    });
  }

  const vscodePath = vscodeUserSettingsPath();
  if (fs.existsSync(vscodePath) || fs.existsSync(path.join(home, '.vscode')) || commandExists('code')) {
    const version = getVSCodeVersion();
    found.push({
      id: 'vscode', name: 'VS Code', scopeable: true,
      globalConfigPath: vscodePath,      globalKeyPath: ['mcp', 'servers'],
      localConfigPath: path.join(process.cwd(), '.vscode', 'mcp.json'), localKeyPath: ['servers'],
      keyPath: ['mcp', 'servers'],
      version,
      warning: version && !semverGte(version, '1.99.0') ? 'Requires Copilot agent mode (v1.99+)' : null,
    });
  }

  return found;
}

function resolveClient(client, scope) {
  const r = { ...client };
  const useGlobal = !client.scopeable || scope === 'global';
  r.configPath = useGlobal ? client.globalConfigPath : client.localConfigPath;
  r.keyPath    = useGlobal ? (client.globalKeyPath || client.keyPath) : (client.localKeyPath || client.keyPath);
  return r;
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function readJson(p) {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function getIn(obj, keys) {
  return keys.reduce((o, k) => o && typeof o === 'object' ? o[k] : undefined, obj);
}

function setIn(obj, keys, value) {
  const last = keys[keys.length - 1];
  const parent = keys.slice(0, -1).reduce((o, k) => {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    return o[k];
  }, obj);
  parent[last] = value;
}

function isAlreadyInstalled(client) {
  const cfg = readJson(client.configPath);
  if (!cfg) return false;
  const servers = getIn(cfg, client.keyPath);
  return !!(servers && servers[MCP_NAME] !== undefined);
}

function installClient(client) {
  const cfg = readJson(client.configPath);
  if (cfg === null) return { ok: false, reason: 'invalid JSON in config file' };
  const dir = path.dirname(client.configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const servers = getIn(cfg, client.keyPath) || {};
  servers[MCP_NAME] = MCP_ENTRY;
  setIn(cfg, client.keyPath, servers);
  try {
    fs.writeFileSync(client.configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('install')) {
    print(`\n  Usage: ${c.cyan('npx dwarf-agillic-docs-mcp install')}\n`);
    process.exit(0);
  }

  // Header
  print('');
  print(`  ${c.cyan('◆')}  ${c.bold('Agillic Docs MCP')}`);
  print(`  ${c.dim('│')}  ${c.dim(MCP_URL)}`);
  print(`  ${c.dim('│')}`);

  // Detect
  const spinner = new Spinner('Detecting editors');
  spinner.start();
  await sleep(isTTY ? 500 : 0);
  const rawClients = detectClients();

  if (rawClients.length === 0) {
    spinner.fail('No supported editors found');
    print(`\n     Supported: Claude Code, Claude Desktop, Cursor, VS Code\n`);
    process.exit(1);
  }
  spinner.clear();

  // Scope
  let scope = 'global';
  if (rawClients.some(cl => cl.scopeable)) {
    const idx = await radioPrompt(
      `Scope  ${c.dim('(Cursor & VS Code only — Claude Code/Desktop are always global)')}`,
      ['Global  — all projects', 'Local   — this project only']
    );
    scope = idx === 0 ? 'global' : 'local';
    print(`  ${c.green('✓')}  ${c.bold('Scope')}  ${c.dim(scope)}`);
    print(`  ${c.dim('│')}`);
  }

  // Resolve + annotate
  const clients = rawClients.map(cl => {
    const r = resolveClient(cl, scope);
    r.alreadyInstalled = isAlreadyInstalled(r);
    return r;
  });

  // Show detected editors
  const NAME_W = 16;
  const VER_W  = 10;
  for (const cl of clients) {
    const icon   = cl.alreadyInstalled ? c.dim('~') : c.green('◆');
    const name   = cl.name.padEnd(NAME_W);
    const verRaw = cl.version ? `v${cl.version}` : '';
    const ver    = c.dim(verRaw.padEnd(VER_W));
    const pth    = c.dim(shortPath(cl.configPath));
    const tag    = cl.scopeable ? c.dim(` [${scope}]`) : '';
    const skip   = cl.alreadyInstalled ? c.dim('  installed') : '';
    const warn   = cl.warning ? `  ${c.yellow('⚠  ' + cl.warning)}` : '';
    print(`  ${c.dim('│')}  ${icon}  ${name}${ver}${pth}${tag}${skip}${warn}`);
  }

  const installable = clients.filter(cl => !cl.alreadyInstalled);
  if (installable.length === 0) {
    print(`  ${c.dim('│')}`);
    print(`  ${c.green('◆')}  Already installed everywhere. Nothing to do.\n`);
    process.exit(0);
  }

  print(`  ${c.dim('│')}`);

  // Select via checkbox
  const chosen = await checkboxPrompt(
    'Where to install?',
    clients.map(cl => ({
      label:    cl.name,
      hint:     cl.version ? `v${cl.version}` : undefined,
      warning:  cl.warning,
      disabled: cl.alreadyInstalled,
    }))
  );

  const selected = chosen.map(i => clients[i]);

  if (selected.length === 0) {
    print(`  ${c.dim('○')}  Nothing selected.\n`);
    process.exit(0);
  }

  print(`  ${c.dim('│')}`);

  // Install
  let anyFailed = false;
  for (const cl of selected) {
    const s = new Spinner(cl.name);
    s.start();
    await sleep(isTTY ? 300 : 0);
    const result = installClient(cl);
    if (result.ok) {
      s.succeed(`${cl.name.padEnd(NAME_W)}  ${c.dim('→ ' + shortPath(cl.configPath))}`);
    } else {
      s.fail(`${cl.name.padEnd(NAME_W)}  ${result.reason}`);
      anyFailed = true;
    }
  }

  print('');
  if (anyFailed) {
    print(`  ${c.yellow('⚠')}  Some installs failed — check errors above.\n`);
  } else {
    print(`  ${c.green('◆')}  ${c.bold('Done!')}  Restart your editor(s) to activate ${c.cyan(MCP_NAME)}.\n`);
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  ansi.showCursor();
  print(`\n  ${c.red('✗')}  ${err.message}\n`);
  process.exit(1);
});
