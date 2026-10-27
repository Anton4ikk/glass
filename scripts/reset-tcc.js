// Clears the stale Screen Recording grant after a rebuild. macOS ties the TCC
// entry to the app's code signature; once it no longer matches, toggling the
// switch in System Settings doesn't help and only a reset makes macOS ask again.
const { execFileSync } = require('child_process');

if (process.platform !== 'darwin') process.exit(0);

const BUNDLE_ID = 'com.pickle.glass';

try {
    execFileSync('tccutil', ['reset', 'ScreenCapture', BUNDLE_ID], { stdio: 'inherit' });
    console.log(`[reset-tcc] Screen Recording permission reset for ${BUNDLE_ID}; grant it again on first launch.`);
} catch (error) {
    // Never fail the build over this.
    console.warn(`[reset-tcc] tccutil reset failed: ${error.message}`);
}
