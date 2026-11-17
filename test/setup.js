// Preloaded into every test process by scripts/run-tests.js.
// App modules log heavily via console.log; keep test output readable.
// Set DEBUG_TESTS=1 to see the logs. console.warn/error stay visible.
if (!process.env.DEBUG_TESTS) {
    const noop = () => {};
    console.log = noop;
    console.info = noop;
    console.debug = noop;
}
