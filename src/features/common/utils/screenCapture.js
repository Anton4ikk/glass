// Screen capture shared by Ask and live insights.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

let sharp = null;
try {
    sharp = require('sharp');
} catch (error) {
    console.warn('[ScreenCapture] sharp not available, screenshots are sent unresized:', error.message);
}

// At 384 px vision models can't read screen text and invent it (gemma4:e4b
// read "main.cpp" off a README). 768 px costs ~440 image tokens vs ~130.
const SCREENSHOT_HEIGHT = 768;

async function captureMac() {
    const tempPath = path.join(os.tmpdir(), `screenshot-${process.pid}-${Date.now()}.jpg`);
    let imageBuffer;
    try {
        await execFile('screencapture', ['-x', '-t', 'jpg', tempPath]);
        imageBuffer = await fs.promises.readFile(tempPath);
    } finally {
        fs.promises.unlink(tempPath).catch(() => {});
    }

    if (sharp) {
        try {
            const { data, info } = await sharp(imageBuffer)
                .resize({ height: SCREENSHOT_HEIGHT, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer({ resolveWithObject: true });
            return { success: true, base64: data.toString('base64'), width: info.width, height: info.height };
        } catch (error) {
            console.warn('[ScreenCapture] sharp failed, sending the original image:', error.message);
        }
    }
    return { success: true, base64: imageBuffer.toString('base64'), width: null, height: null };
}

async function captureWithDesktopCapturer() {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
    });
    if (sources.length === 0) throw new Error('No screen sources available');

    const { thumbnail } = sources[0];
    const size = thumbnail.getSize();
    return { success: true, base64: thumbnail.toJPEG(70).toString('base64'), width: size.width, height: size.height };
}

// Ask and the live analysis often ask for the screen at the same moment (an
// analysis triggers an auto answer); concurrent callers share one capture.
let inFlight = null;

/** @returns {Promise<{success: true, base64: string, width: ?number, height: ?number} | {success: false, error: string}>} */
function captureScreenshot() {
    if (!inFlight) {
        const capture = process.platform === 'darwin' ? captureMac : captureWithDesktopCapturer;
        inFlight = capture()
            .catch(error => {
                console.error('[ScreenCapture] Failed to capture screenshot:', error.message);
                return { success: false, error: error.message };
            })
            .finally(() => {
                inFlight = null;
            });
    }
    return inFlight;
}

module.exports = { captureScreenshot };
