const OpenAI = require('openai');
const WebSocket = require('ws');
const { Portkey } = require('portkey-ai');
const { Readable } = require('stream');
const { getProviderForModel } = require('../factory.js');


class OpenAIProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string' || !key.startsWith('sk-')) {
            return { success: false, error: 'Invalid OpenAI API key format.' };
        }

        try {
            const response = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (response.ok) {
                return { success: true };
            } else {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error?.message || `Validation failed with status: ${response.status}`;
                return { success: false, error: message };
            }
        } catch (error) {
            console.error(`[OpenAIProvider] Network error during key validation:`, error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}


/**
 * Creates an OpenAI STT session
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.language='en'] - Language code
 * @param {object} [opts.callbacks] - Event callbacks
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {Promise<object>} STT session
 */
async function createSTT({ apiKey, language = 'en', callbacks = {}, usePortkey = false, portkeyVirtualKey, sessionType = 'unknown', ...config }) {
  const keyType = usePortkey ? 'vKey' : 'apiKey';
  const key = usePortkey ? (portkeyVirtualKey || apiKey) : apiKey;

  const wsUrl = keyType === 'apiKey'
    ? 'wss://api.openai.com/v1/realtime?intent=transcription'
    : 'wss://api.portkey.ai/v1/realtime?intent=transcription';

  const headers = keyType === 'apiKey'
    ? { 'Authorization': `Bearer ${key}`, 'OpenAI-Beta': 'realtime=v1' }
    : { 'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu', 'x-portkey-virtual-key': key, 'OpenAI-Beta': 'realtime=v1' };

  const isTheirSession = sessionType === 'their';

  const sessionUpdatePayload = JSON.stringify({
    type: 'transcription_session.update',
    session: {
      input_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'gpt-4o-mini-transcribe',
        prompt: config.prompt || '',
        language: language || 'en'
      },
      turn_detection: {
        type: 'server_vad',
        threshold: isTheirSession ? 0.05 : 0.1,
        prefix_padding_ms: isTheirSession ? 500 : 200,
        silence_duration_ms: isTheirSession ? 1000 : 500,
      },
      ...(isTheirSession ? {} : { input_audio_noise_reduction: { type: 'near_field' } })
    }
  });

  // Mutable references updated on each reconnect
  let activeWs = null;
  let forceCommitInterval = null;
  let userClosed = false;
  let reconnectTimer = null;

  // Session handle returned to callers – methods close over mutable activeWs
  const session = {
    sendRealtimeInput(audioData) {
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audioData }));
      }
    },
    keepAlive() {
      try {
        if (activeWs && activeWs.readyState === WebSocket.OPEN) activeWs.ping();
      } catch (err) {
        console.error('[OpenAI STT] keepAlive error:', err.message);
      }
    },
    close() {
      userClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (forceCommitInterval) { clearInterval(forceCommitInterval); forceCommitInterval = null; }
      if (activeWs && activeWs.readyState === WebSocket.OPEN) {
        activeWs.send(JSON.stringify({ type: 'session.close' }));
        activeWs.onmessage = activeWs.onerror = () => {};
        activeWs.close(1000, 'Client initiated close.');
      }
    }
  };

  function connect(onFirstOpen) {
    const ws = new WebSocket(wsUrl, { headers });
    activeWs = ws;

    ws.onopen = () => {
      console.log(`WebSocket session opened [${sessionType}].`);
      ws.send(sessionUpdatePayload);
      console.log(`[OpenAI STT ${sessionType}] Session config: threshold=${isTheirSession ? 0.05 : 0.1} noise_reduction: ${isTheirSession ? 'none' : 'near_field'}`);

      if (isTheirSession) {
        if (forceCommitInterval) clearInterval(forceCommitInterval);
        forceCommitInterval = setInterval(() => {
          if (activeWs === ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            console.log(`[OpenAI STT their] force-commit sent`);
          }
        }, 3000);
      }

      if (onFirstOpen) onFirstOpen(session);
    };

    ws.onmessage = (event) => {
      if (!event.data || event.data === 'null' || event.data === '[DONE]') return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      const silentTypes = isTheirSession ? [] : ['input_audio_buffer.committed'];
      if (!silentTypes.includes(msg.type)) {
        console.log(`[OpenAI WS ${sessionType}]`, msg.type, JSON.stringify(msg).substring(0, 150));
      }

      msg.provider = 'openai';
      callbacks.onmessage?.(msg);
    };

    ws.onerror = (error) => {
      console.error(`[OpenAI STT ${sessionType}] WebSocket error:`, error.message);
      callbacks.onerror?.(error);
    };

    ws.onclose = (event) => {
      console.log(`[OpenAI STT ${sessionType}] WebSocket closed: code=${event.code} reason='${event.reason}'`);
      if (forceCommitInterval && activeWs === ws) { clearInterval(forceCommitInterval); forceCommitInterval = null; }
      callbacks.onclose?.(event);
      if (!userClosed) {
        console.log(`[OpenAI STT ${sessionType}] Reconnecting in 3s...`);
        reconnectTimer = setTimeout(() => connect(null), 3000);
      }
    };
  }

  return new Promise((resolve, reject) => {
    connect(resolve);
    // Reject promise on initial connection error (no-op if already resolved)
    const origError = activeWs.onerror;
    activeWs.onerror = (error) => { origError?.(error); reject(error); };
  });
}

/**
 * Creates an OpenAI LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.model='gpt-4.1'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=2048] - Max tokens
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {object} LLM instance
 */
function createLLM({ apiKey, model = 'gpt-4.1-mini', temperature = 0.7, maxTokens = 2048, usePortkey = false, portkeyVirtualKey, ...config }) {
  const client = new OpenAI({ apiKey });
  
  const callApi = async (messages) => {
    if (!usePortkey) {
      const response = await client.chat.completions.create({
        model: model,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens
      });
      return {
        content: response.choices[0].message.content.trim(),
        raw: response
      };
    } else {
      const fetchUrl = 'https://api.portkey.ai/v1/chat/completions';
      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: {
            'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
            'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: model,
            messages,
            temperature,
            max_tokens: maxTokens,
        }),
      });

      if (!response.ok) {
        throw new Error(`Portkey API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      return {
        content: result.choices[0].message.content.trim(),
        raw: result
      };
    }
  };

  return {
    generateContent: async (parts) => {
      const messages = [];
      let systemPrompt = '';
      let userContent = [];
      
      for (const part of parts) {
        if (typeof part === 'string') {
          if (systemPrompt === '' && part.includes('You are')) {
            systemPrompt = part;
          } else {
            userContent.push({ type: 'text', text: part });
          }
        } else if (part.inlineData) {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
          });
        }
      }
      
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      if (userContent.length > 0) messages.push({ role: 'user', content: userContent });
      
      const result = await callApi(messages);

      return {
        response: {
          text: () => result.content
        },
        raw: result.raw
      };
    },
    
    // For compatibility with chat-style interfaces
    chat: async (messages) => {
      return await callApi(messages);
    }
  };
}

/** 
 * Creates an OpenAI streaming LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.model='gpt-4.1'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=2048] - Max tokens
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {object} Streaming LLM instance
 */
function createStreamingLLM({ apiKey, model = 'gpt-4.1-mini', temperature = 0.7, maxTokens = 2048, usePortkey = false, portkeyVirtualKey, ...config }) {
  return {
    streamChat: async (messages) => {
      const fetchUrl = usePortkey 
        ? 'https://api.portkey.ai/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
      
      const headers = usePortkey
        ? {
            'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
            'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
            'Content-Type': 'application/json',
          }
        : {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          };

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      return response;
    }
  };
}

module.exports = {
    OpenAIProvider,
    createSTT,
    createLLM,
    createStreamingLLM
}; 