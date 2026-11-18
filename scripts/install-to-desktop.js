// macOS builds live in one place only: ~/Desktop/Glass.app. After
// electron-builder finishes, this moves the fresh .app there (replacing the
// old one) and deletes dist/, so no stale copy is left to launch by mistake.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'darwin' || process.env.CI) process.exit(0);

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP_NAME = 'Glass.app';
const BUNDLE_ID = 'com.pickle.glass';
const TARGET = path.join(os.homedir(), 'Desktop', APP_NAME);

function findBuiltApp() {
    if (!fs.existsSync(DIST)) return null;
    // electron-builder writes dist/mac, dist/mac-arm64 or dist/mac-universal.
    const candidates = fs
        .readdirSync(DIST)
        .filter(dir => dir.startsWith('mac'))
        .map(dir => path.join(DIST, dir, APP_NAME))
        .filter(app => fs.existsSync(app))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] || null;
}

function isRunning() {
    try {
        execFileSync('pgrep', ['-f', `${APP_NAME}/Contents/MacOS/`], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// Replacing the bundle under a running app breaks it, so quit it first.
function quitRunningApp() {
    if (!isRunning()) return;
    console.log('[install-to-desktop] Quitting the running Glass...');
    try {
        execFileSync('osascript', ['-e', `quit app id "${BUNDLE_ID}"`], { stdio: 'ignore', timeout: 10000 });
    } catch {
        // Fall through to the wait/kill below.
    }
    const deadline = Date.now() + 10000;
    while (isRunning() && Date.now() < deadline) execFileSync('sleep', ['0.5']);
    if (isRunning()) {
        execFileSync('pkill', ['-TERM', '-f', `${APP_NAME}/Contents/MacOS/`], { stdio: 'ignore' });
        execFileSync('sleep', ['2']);
    }
}

const built = findBuiltApp();
if (!built) {
    console.error(`[install-to-desktop] No ${APP_NAME} under ${DIST}; nothing installed.`);
    process.exit(1);
}

quitRunningApp();
fs.rmSync(TARGET, { recursive: true, force: true });
try {
    fs.renameSync(built, TARGET);
} catch {
    // Different volume: copy, keeping the code signature's extended attributes.
    execFileSync('ditto', [built, TARGET], { stdio: 'inherit' });
}
fs.rmSync(DIST, { recursive: true, force: true });
console.log(`[install-to-desktop] Installed ${TARGET} and removed dist/.`);
