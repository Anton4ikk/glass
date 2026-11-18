const { EventEmitter } = require('events');

// In-process event bus between feature services and the window manager.
const internalBridge = new EventEmitter();
module.exports = internalBridge;
