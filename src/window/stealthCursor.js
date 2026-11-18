// Keeps the mouse cursor a plain arrow over Glass windows while invisibility
// (content protection) is on. Content protection hides the windows from screen
// capture, but the cursor is still captured. If it turned into a hand or an
// I-beam over "empty" screen, viewers would notice a hidden overlay.
//
// Lit components style themselves inside shadow roots, which document-level
// CSS can't reach. `webContents.insertCSS({ cssOrigin: 'user' })` does pierce
// shadow DOM, but Chromium never un-applies a removed user sheet, so it can't
// be switched off. Instead, one constructed stylesheet is adopted into the
// document and into every shadow root (existing and future), and its rule is
// swapped on toggle.

/* global window, document, CSSStyleSheet, ShadowRoot */

// Runs in the renderer's main world via executeJavaScript (serialized with
// toString), so it must not reference anything outside its own body.
function rendererSetStealthCursor(enabled) {
    const RULE = '*, *::before, *::after { cursor: default !important; }';
    let state = window.__glassStealthCursor;
    if (!state) {
        const sheet = new CSSStyleSheet();
        const desc = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets');
        const withSheet = list => {
            const arr = Array.from(list);
            return arr.includes(sheet) ? arr : [...arr, sheet];
        };
        // Lit assigns `renderRoot.adoptedStyleSheets = [...]` when a component
        // connects, which would drop our sheet. Re-append it on every set.
        Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
                return desc.get.call(this);
            },
            set(value) {
                desc.set.call(this, withSheet(value));
            },
        });
        const adoptDeep = root => {
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                    el.shadowRoot.adoptedStyleSheets = withSheet(el.shadowRoot.adoptedStyleSheets);
                    adoptDeep(el.shadowRoot);
                }
            }
        };
        document.adoptedStyleSheets = withSheet(document.adoptedStyleSheets);
        adoptDeep(document);
        state = window.__glassStealthCursor = { sheet, rule: RULE };
    }
    state.sheet.replaceSync(enabled ? state.rule : '');
    return enabled;
}

function setStealthCursor(win, enabled) {
    if (!win || win.isDestroyed()) return Promise.resolve(false);
    const code = `(${rendererSetStealthCursor.toString()})(${Boolean(enabled)})`;
    return win.webContents.executeJavaScript(code).catch(error => {
        console.warn('[StealthCursor] Failed to apply:', error.message);
        return false;
    });
}

// Re-applies after every (re)load, since each new document starts clean.
function attachStealthCursor(win, isEnabled) {
    if (!win || win.isDestroyed()) return;
    win.webContents.on('dom-ready', () => setStealthCursor(win, isEnabled()));
    if (!win.webContents.isLoading()) setStealthCursor(win, isEnabled());
}

module.exports = { setStealthCursor, attachStealthCursor };
