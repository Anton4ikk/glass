#!/usr/bin/env node
// Claude Code Stop + SubagentStop hook: runs `npm run check` (lint errors + tests)
// before Claude or a subagent ends its turn, and sends failures back so it fixes them.
//
// - Skips when no lintable/testable file differs from HEAD, or when the same
//   set of changes already passed (fingerprint stored in .git/).
// - Blocks at most MAX_BLOCKS times in a row per session, then lets Claude stop
//   and tells the user, so a check Claude can't fix never loops forever.
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BLOCKS = 3;
const OUTPUT_TAIL_LINES = 80;
const WATCHED = ['src', 'test', 'scripts', 'pickleglass_web/backend_node', 'functions', '*.js', 'package.json'];

const root = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..', '..');

function readStdin() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
        return {};
    }
}

function git(args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

// Hash of the content of every watched JS/JSON file that differs from HEAD (incl. untracked).
function changesFingerprint() {
    const status = git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...WATCHED]);
    const files = status
        .split('\n')
        .filter(Boolean)
        .map(line => line.slice(3).split(' -> ').pop())
        .filter(f => /\.(js|json)$/.test(f))
        .sort();
    if (files.length === 0) return null;

    const hash = crypto.createHash('sha1');
    for (const file of files) {
        const full = path.join(root, file);
        hash.update(file + '\0');
        hash.update(fs.existsSync(full) ? fs.readFileSync(full) : 'deleted');
    }
    return hash.digest('hex');
}

function stateFile(name) {
    return path.join(root, '.git', name);
}

function readState(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        return '';
    }
}

const input = readStdin();
// Also wired to SubagentStop. Subagents share the parent's session_id, so key the
// block counter by agent_id too, or they would eat into the main agent's attempts.
const counterKey = [input.session_id || 'default', input.agent_id].filter(Boolean).join('-');
const counterFile = path.join(os.tmpdir(), `claude-check-blocks-${counterKey}`);
const okFile = stateFile('claude-check-ok');

let fingerprint;
try {
    fingerprint = changesFingerprint();
} catch {
    process.exit(0); // not a git checkout or git missing: don't get in the way
}
if (!fingerprint || fingerprint === readState(okFile)) process.exit(0);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync('npm', ['run', 'check', '--silent'], { cwd: root, env, encoding: 'utf8', shell: process.platform === 'win32' });

if (result.status === 0) {
    fs.writeFileSync(okFile, fingerprint);
    fs.rmSync(counterFile, { force: true });
    process.exit(0);
}

const blocks = Number(readState(counterFile) || 0) + 1;
if (blocks > MAX_BLOCKS) {
    fs.rmSync(counterFile, { force: true });
    console.log(JSON.stringify({
        systemMessage: `npm run check still fails after ${MAX_BLOCKS} attempts; stopping anyway. Run it yourself to see the errors.`,
    }));
    process.exit(0);
}
fs.writeFileSync(counterFile, String(blocks));

const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n');
const tail = output.slice(-OUTPUT_TAIL_LINES).join('\n');
console.log(JSON.stringify({
    decision: 'block',
    reason:
        `\`npm run check\` failed (attempt ${blocks}/${MAX_BLOCKS}). Fix the lint errors / failing tests below, then finish. ` +
        `If a failure comes from files you did not touch (e.g. another session's edits), say so instead of changing them.\n\n` +
        tail,
}));
