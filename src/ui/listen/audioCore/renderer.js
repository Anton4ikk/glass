const listenCapture = require('./listenCapture.js');

const isListenView = new URLSearchParams(window.location.search).get('view') === 'listen';

window.pickleGlass = {
    startCapture: listenCapture.startCapture,
    stopCapture: listenCapture.stopCapture,
    isLinux: listenCapture.isLinux,
    isMacOS: listenCapture.isMacOS,
};

// Every feature window loads this bundle; only the listen window captures audio.
window.api.renderer.onChangeListenCaptureState((_event, { status }) => {
    if (!isListenView) return;
    if (status === 'stop') {
        listenCapture.stopCapture();
    } else {
        listenCapture.startCapture();
    }
});
