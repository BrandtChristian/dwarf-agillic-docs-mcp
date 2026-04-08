#!/usr/bin/env node
'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const MCP_NAME = 'agillic-docs';
const MCP_URL = 'https://agimcp.dwarf.dk/mcp';
const MCP_ENTRY = { type: 'http', url: MCP_URL };

const home = os.homedir();
const platform = process.platform;

// ─── Colors ───────────────────────────────────────────────────────────────────

const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

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
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function semverGte(version, min) {
  const parse = v => v.split('.').map(n => parseInt(n) || 0);
  const [va, vb] = [parse(version), parse(min)];
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const a = va[i] || 0, b = vb[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function getClaudeDesktopVersion() {
  try {
    if (platform === 'darwin') {
      const plist = '/Applications/Claude.app/Contents/Info.plist';
      if (fs.existsSync(plist)) {
        return execSync(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${plist}"`,
          { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
      }
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
//
// Returns a list of potential install targets. Each has:
//   id, name, configPath, keyPath[], warning, scopeable
//
// scopeable = true means we show global/local choice for it.
// Actual configPath for scopeable clients is resolved after we know the scope.

function detectClients() {
  const found = [];

  // Claude Code
  if (fs.existsSync(path.join(home, '.claude'))) {
    found.push({
      id: 'claude-code',
      name: 'Claude Code',
      scopeable: false,
      globalConfigPath: path.join(home, '.claude', 'settings.json'),
      localConfigPath: null,
      keyPath: ['mcpServers'],
      warning: null,
    });
  }

  // Claude Desktop
  const desktopPath = claudeDesktopConfigPath();
  if (fs.existsSync(desktopPath)) {
    const desktopVersion = getClaudeDesktopVersion();
    const desktopWarning = desktopVersion && !semverGte(desktopVersion, '0.9.0')
      ? `HTTP MCPs require v0.9+ (you have ${desktopVersion})`
      : null;
    found.push({
      id: 'claude-desktop',
      name: 'Claude Desktop',
      scopeable: false,
      globalConfigPath: desktopPath,
      localConfigPath: null,
      keyPath: ['mcpServers'],
      version: desktopVersion,
      warning: desktopWarning,
    });
  }

  // Cursor
  if (fs.existsSync(path.join(home, '.cursor'))) {
    found.push({
      id: 'cursor',
      name: 'Cursor',
      scopeable: true,
      globalConfigPath: path.join(home, '.cursor', 'mcp.json'),
      localConfigPath: path.join(process.cwd(), '.cursor', 'mcp.json'),
      keyPath: ['mcpServers'],
      warning: null,
    });
  }

  // VS Code
  const vscodePath = vscodeUserSettingsPath();
  const vscodeFound = fs.existsSync(vscodePath) || fs.existsSync(path.join(home, '.vscode')) || commandExists('code');
  if (vscodeFound) {
    const vscodeVersion = getVSCodeVersion();
    const vscodeWarning = vscodeVersion && !semverGte(vscodeVersion, '1.99.0')
      ? `Requires Copilot agent mode (v1.99+, you have ${vscodeVersion})`
      : null;
    found.push({
      id: 'vscode',
      name: 'VS Code',
      scopeable: true,
      globalConfigPath: vscodePath,
      globalKeyPath: ['mcp', 'servers'],
      localConfigPath: path.join(process.cwd(), '.vscode', 'mcp.json'),
      localKeyPath: ['servers'],
      keyPath: ['mcp', 'servers'], // default; overridden below based on scope
      version: vscodeVersion,
      warning: vscodeWarning,
    });
  }

  return found;
}

function resolveClient(client, scope) {
  const resolved = { ...client };
  if (!client.scopeable || scope === 'global') {
    resolved.configPath = client.globalConfigPath;
    resolved.keyPath = client.globalKeyPath || client.keyPath;
  } else {
    resolved.configPath = client.localConfigPath;
    resolved.keyPath = client.localKeyPath || client.keyPath;
  }
  return resolved;
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function getIn(obj, keys) {
  return keys.reduce((cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), obj);
}

function setIn(obj, keys, value) {
  const last = keys[keys.length - 1];
  const parent = keys.slice(0, -1).reduce((cur, k) => {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    return cur[k];
  }, obj);
  parent[last] = value;
}

function isAlreadyInstalled(client) {
  const config = readJson(client.configPath);
  if (!config) return false;
  const servers = getIn(config, client.keyPath);
  return !!(servers && servers[MCP_NAME] !== undefined);
}

function installClient(client) {
  let config = readJson(client.configPath);
  if (config === null) return { ok: false, reason: 'invalid JSON in existing config' };

  const dir = path.dirname(client.configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = getIn(config, client.keyPath) || {};
  existing[MCP_NAME] = MCP_ENTRY;
  setIn(config, client.keyPath, existing);

  try {
    fs.writeFileSync(client.configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

function shortPath(p) {
  return p.replace(home, '~');
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('install')) {
    console.log(`\nUsage: ${c.cyan('npx dwarf-agillic-docs-mcp install')}\n`);
    process.exit(0);
  }

  console.log(`\n${c.bold('Agillic Docs MCP — Installer')}`);
  console.log(c.dim(`  MCP server: ${MCP_URL}\n`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── Step 1: detect clients ────────────────────────────────────────────────
  const rawClients = detectClients();

  if (rawClients.length === 0) {
    console.log(c.red('  No compatible MCP clients found.\n'));
    console.log('  Supported: Claude Code, Claude Desktop, Cursor, VS Code\n');
    rl.close();
    process.exit(1);
  }

  // ── Step 2: scope (only ask if scopeable clients exist) ───────────────────
  let scope = 'global';
  const hasScopeable = rawClients.some(cl => cl.scopeable);
  if (hasScopeable) {
    const scopeAnswer = await ask(rl,
      `Install ${c.cyan('globally')} (all projects) or ${c.cyan('locally')} (this project only)?\n` +
      `  Applies to Cursor and VS Code. Claude Code / Desktop are always global.\n\n` +
      `  [g] Global   [l] Local\n\n> `
    );
    if (scopeAnswer.toLowerCase().startsWith('l')) scope = 'local';
    console.log();
  }

  // ── Step 3: resolve paths and show what was found ─────────────────────────
  const clients = rawClients.map(cl => resolveClient(cl, scope));

  console.log('Found:\n');
  for (const client of clients) {
    const already = isAlreadyInstalled(client);
    const icon = already ? c.dim('~') : c.green('✓');
    const warn = client.warning ? `  ${c.yellow('⚠  ' + client.warning)}` : '';
    const alreadyNote = already ? c.dim('  already installed') : '';
    const scopeLabel = client.scopeable ? c.dim(` [${scope}]`) : '';
    const versionLabel = client.version ? c.dim(` v${client.version}`) : '';
    console.log(`  ${icon}  ${client.name.padEnd(16)}${versionLabel.padEnd(versionLabel ? 10 : 0)} ${c.dim(shortPath(client.configPath))}${scopeLabel}${warn}${alreadyNote}`);
  }

  const installable = clients.filter(cl => !isAlreadyInstalled(cl));

  if (installable.length === 0) {
    console.log(`\n${c.green('Nothing to do')} — all found clients already have ${MCP_NAME} installed.\n`);
    rl.close();
    return;
  }

  // ── Step 4: select ────────────────────────────────────────────────────────
  console.log('\nWhere would you like to install?\n');
  installable.forEach((client, i) => {
    const warn = client.warning ? `  ${c.yellow('⚠  ' + client.warning)}` : '';
    console.log(`  [${i + 1}] ${client.name}${warn}`);
  });
  console.log(`  [a] All of the above`);
  console.log(`  [q] Quit\n`);

  const sel = await ask(rl, '> ');
  rl.close();
  console.log();

  let selected = [];
  if (sel.toLowerCase() === 'q') {
    console.log('Aborted.\n');
    process.exit(0);
  } else if (sel.toLowerCase() === 'a') {
    selected = installable;
  } else {
    const indices = sel.split(/[\s,]+/).map(s => parseInt(s) - 1).filter(i => i >= 0 && i < installable.length);
    selected = indices.map(i => installable[i]);
  }

  if (selected.length === 0) {
    console.log(c.yellow('No valid selection. Aborted.\n'));
    process.exit(1);
  }

  // ── Step 5: install ───────────────────────────────────────────────────────
  console.log('Installing...\n');
  let anyFailed = false;
  for (const client of selected) {
    const result = installClient(client);
    if (result.ok) {
      console.log(`  ${c.green('✓')}  ${client.name.padEnd(16)} → ${c.dim(shortPath(client.configPath))}`);
    } else {
      console.log(`  ${c.red('✗')}  ${client.name.padEnd(16)} failed: ${result.reason}`);
      anyFailed = true;
    }
  }

  console.log(`\n${c.bold('Done!')} Restart your editor(s) to activate the ${MCP_NAME} MCP.\n`);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error(c.red('\nUnexpected error: ' + err.message));
  process.exit(1);
});
