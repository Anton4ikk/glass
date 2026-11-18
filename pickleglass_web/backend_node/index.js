const express = require('express');
const cors = require('cors');

// Local API for the web dashboard. It runs inside the Electron main process and
// never touches the database itself: routes forward requests over the in-process
// event bridge (see ipcBridge.js), answered by setupWebDataHandlers() in src/index.js.
function createApp(eventBridge) {
    const app = express();

    const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
    console.log(`🔧 Backend CORS configured for: ${webUrl}`);

    app.use(cors({
        origin: webUrl,
        credentials: true,
    }));

    app.use(express.json());

    app.get('/', (req, res) => {
        res.json({ message: "pickleglass API is running" });
    });

    app.use((req, res, next) => {
        req.bridge = eventBridge;
        next();
    });

    app.use('/api/settings', require('./routes/settings'));
    app.use('/api/conversations', require('./routes/conversations'));
    app.use('/api/presets', require('./routes/presets'));

    return app;
}

module.exports = createApp;
