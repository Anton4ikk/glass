// Client for the local API (pickleglass_web/backend_node), which runs inside the
// Electron main process and reads/writes the local SQLite database.

export interface Session {
  id: string;
  title: string;
  session_type: string;
  started_at: number;
  ended_at?: number;
  updated_at: number;
}

export interface Transcript {
  id: string;
  session_id: string;
  start_at: number;
  end_at?: number;
  speaker?: string;
  text: string;
  lang?: string;
  created_at: number;
}

export interface AiMessage {
  id: string;
  session_id: string;
  sent_at: number;
  role: 'user' | 'assistant';
  content: string;
  tokens?: number;
  model?: string;
  created_at: number;
}

export interface Summary {
  session_id: string;
  generated_at: number;
  model?: string;
  text: string;
  tldr: string;
  bullet_json: string;
  action_json: string;
  tokens_used?: number;
  updated_at: number;
}

export interface PromptPreset {
  id: string;
  title: string;
  prompt: string;
  is_default: 0 | 1;
  created_at: number;
}

export interface SessionDetails {
  session: Session;
  transcripts: Transcript[];
  ai_messages: AiMessage[];
  summary: Summary | null;
}

let API_ORIGIN = process.env.NODE_ENV === 'development'
  ? 'http://localhost:9001'
  : '';

// The main process picks the API port at runtime and serves it here.
const loadRuntimeConfig = async (): Promise<string | null> => {
  try {
    const response = await fetch('/runtime-config.json');
    if (response.ok) {
      const config = await response.json();
      return config.API_URL;
    }
  } catch (error) {
    console.log('Failed to load runtime config:', error);
  }
  return null;
};

let apiUrlInitialized = false;
let initializationPromise: Promise<void> | null = null;

const initializeApiUrl = async () => {
  if (apiUrlInitialized) return;

  const runtimeUrl = await loadRuntimeConfig();
  if (runtimeUrl) {
    API_ORIGIN = runtimeUrl;
  } else {
    console.log('Using fallback API URL:', API_ORIGIN);
  }
  apiUrlInitialized = true;
};

if (typeof window !== 'undefined') {
  initializationPromise = initializeApiUrl();
}

export const apiCall = async (path: string, options: RequestInit = {}) => {
  if (!apiUrlInitialized && initializationPromise) {
    await initializationPromise;
  }

  if (!apiUrlInitialized) {
    await initializeApiUrl();
  }

  return fetch(`${API_ORIGIN}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
};

export const searchConversations = async (query: string): Promise<Session[]> => {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const sessions = await getSessions();
  return sessions.filter(session => (session.title || '').toLowerCase().includes(q));
};

export const getSessions = async (): Promise<Session[]> => {
  const response = await apiCall(`/api/conversations`, { method: 'GET' });
  if (!response.ok) throw new Error('Failed to fetch sessions');
  return response.json();
};

export const getSessionDetails = async (sessionId: string): Promise<SessionDetails> => {
  const response = await apiCall(`/api/conversations/${sessionId}`, { method: 'GET' });
  if (!response.ok) throw new Error('Failed to fetch session details');
  return response.json();
};

export const createSession = async (title?: string): Promise<{ id: string }> => {
  const response = await apiCall(`/api/conversations`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error('Failed to create session');
  return response.json();
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  const response = await apiCall(`/api/conversations/${sessionId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete session');
};

export const saveApiKey = async (apiKey: string): Promise<void> => {
  const response = await apiCall(`/api/settings/api-key`, {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  });
  if (!response.ok) throw new Error('Failed to save API key');
};

export const checkApiKeyStatus = async (): Promise<{ hasApiKey: boolean }> => {
  const response = await apiCall(`/api/settings/api-key-status`, { method: 'GET' });
  if (!response.ok) throw new Error('Failed to check API key status');
  return response.json();
};

export const getPresets = async (): Promise<PromptPreset[]> => {
  const response = await apiCall(`/api/presets`, { method: 'GET' });
  if (!response.ok) throw new Error('Failed to fetch presets');
  return response.json();
};

export const createPreset = async (data: { title: string, prompt: string }): Promise<{ id: string }> => {
  const response = await apiCall(`/api/presets`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error('Failed to create preset');
  return response.json();
};

export const updatePreset = async (id: string, data: { title: string, prompt: string }): Promise<void> => {
  const response = await apiCall(`/api/presets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update preset: ${response.status} ${errorText}`);
  }
};

export const deletePreset = async (id: string): Promise<void> => {
  const response = await apiCall(`/api/presets/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete preset');
};
