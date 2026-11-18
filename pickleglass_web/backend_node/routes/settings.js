const express = require('express');
const router = express.Router();
const { ipcRequest } = require('../ipcBridge');

router.post('/api-key', async (req, res) => {
    try {
        const { apiKey, provider = 'openai' } = req.body;
        await ipcRequest(req, 'save-api-key', { apiKey, provider });
        res.json({ message: 'API key saved successfully' });
    } catch (error) {
        console.error('Failed to save API key via IPC:', error);
        res.status(500).json({ error: 'Failed to save API key' });
    }
});

router.get('/api-key-status', async (req, res) => {
    try {
        const status = await ipcRequest(req, 'check-api-key-status');
        res.json(status);
    } catch (error) {
        console.error('Failed to get API key status via IPC:', error);
        res.status(500).json({ error: 'Failed to get API key status' });
    }
});

module.exports = router;
