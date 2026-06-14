/**
 * OpenClaw Frontend Core - API v3.0
 * Unified API client with interceptors, caching, and error handling
 */

class APIClient {
  constructor(options = {}) {
    this.baseURL = options.baseURL || '';
    this.timeout = options.timeout || 30000;
    this.headers = options.headers || {};
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    this.cache = new Map();
    this.cacheEnabled = options.cache !== false;
  }
  
  // Add request interceptor
  requestInterceptor(fn) {
    this.requestInterceptors.push(fn);
    return this;
  }
  
  // Add response interceptor
  responseInterceptor(fn) {
    this.responseInterceptors.push(fn);
    return this;
  }
  
  // Build full URL
  buildURL(path) {
    if (path.startsWith('http')) return path;
    return this.baseURL.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
  }
  
  // Make request
  async request(method, path, options = {}) {
    const url = this.buildURL(path);
    const { params, body, headers: customHeaders, cache, timeout = this.timeout } = options;
    
    // Build query string
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    const fullURL = url + queryString;
    
    // Check cache for GET requests
    if (method === 'GET' && cache !== false && this.cacheEnabled) {
      const cached = this.cache.get(fullURL);
      if (cached && Date.now() - cached.time < (cache?.ttl || 60000)) {
        return cached.data;
      }
    }
    
    // Prepare request config
    let config = {
      method,
      url: fullURL,
      headers: { ...this.headers, ...customHeaders },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      timeout
    };
    
    // Apply request interceptors
    for (const interceptor of this.requestInterceptors) {
      config = await interceptor(config) || config;
    }
    
    // Make request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(config.url, {
        method: config.method,
        headers: config.headers,
        body: config.body,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Parse response
      let data;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }
      
      // Handle errors
      if (!response.ok) {
        const error = new Error(data?.message || data || `HTTP ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      
      // Apply response interceptors
      for (const interceptor of this.responseInterceptors) {
        data = await interceptor(data, response) ?? data;
      }
      
      // Cache GET responses
      if (method === 'GET' && cache !== false && this.cacheEnabled) {
        this.cache.set(fullURL, { data, time: Date.now() });
      }
      
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }
  
  // HTTP methods
  get(path, options = {}) {
    return this.request('GET', path, options);
  }
  
  post(path, body, options = {}) {
    return this.request('POST', path, { ...options, body });
  }
  
  put(path, body, options = {}) {
    return this.request('PUT', path, { ...options, body });
  }
  
  patch(path, body, options = {}) {
    return this.request('PATCH', path, { ...options, body });
  }
  
  delete(path, options = {}) {
    return this.request('DELETE', path, options);
  }
  
  // Streaming request
  async stream(path, body, onChunk, options = {}) {
    const url = this.buildURL(path);
    const controller = new AbortController();
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...this.headers, ...options.headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      onChunk(chunk);
    }
    
    return controller;
  }
  
  // Clear cache
  clearCache(pattern) {
    if (!pattern) {
      this.cache.clear();
    } else {
      for (const key of this.cache.keys()) {
        if (key.includes(pattern)) {
          this.cache.delete(key);
        }
      }
    }
  }
  
  // Invalidate cache entry
  invalidate(path) {
    for (const key of this.cache.keys()) {
      if (key.includes(path)) {
        this.cache.delete(key);
      }
    }
  }
}

// Create API client
export const api = new APIClient({
  baseURL: '',
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add auth header interceptor
api.requestInterceptor((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Add error handling interceptor
api.responseInterceptor(
  (data) => data,
  async (error) => {
    if (error.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    throw error;
  }
);

// API endpoints
export const endpoints = {
  // Chat
  chat: {
    send: (message, options = {}) => api.post('/chat', { message, ...options }),
    stream: (message, onChunk, options = {}) => api.stream('/chat', { message, ...options }, onChunk),
    history: () => api.get('/chat/history')
  },
  
  // Search
  search: {
    vault: (query, options = {}) => api.get('/search', { params: { q: query, ...options } }),
    code: (query) => api.get('/search/code', { params: { q: query } }),
    suggest: (query) => api.get('/search/suggest', { params: { q: query } })
  },
  
  // CodeGraph
  codegraph: {
    status: () => api.get('/codegraph/status'),
    search: (query, options = {}) => api.get('/codegraph/search', { params: { q: query, ...options } }),
    init: () => api.post('/codegraph/init'),
    fileIndex: () => api.get('/file-index')
  },
  
  // Agents
  agents: {
    status: () => api.get('/agents/status'),
    generate: (code, options = {}) => api.post('/agents/opencode/generate', { code, ...options }),
    refactor: (code, instructions) => api.post('/agents/opencode/refactor', { code, instructions }),
    review: (code) => api.post('/agents/opencode/review', { code }),
    test: (code) => api.post('/agents/opencode/test', { code })
  },
  
  // Router
  router: {
    status: () => api.get('/advisor/status'),
    health: () => api.get('/advisor/health'),
    tokenStats: () => api.get('/memory/usage')
  },
  
  // Vault
  vault: {
    stats: () => api.get('/vault/stats'),
    tags: () => api.get('/vault/tags'),
    para: () => api.get('/vault/para'),
    network: (path) => api.get(`/vault/network/${encodeURIComponent(path)}`)
  },
  
  // Knowledge Graph
  kg: {
    stats: () => api.get('/kg/stats'),
    entities: () => api.get('/kg/entities'),
    graph: () => api.get('/kg/graph')
  },
  
  // Performance
  perf: {
    metrics: () => api.get('/metrics'),
    native: () => api.get('/native/stats').catch(() => null)
  },
  
  // System
  system: {
    health: () => api.get('/health'),
    version: () => api.get('/version'),
    config: () => api.get('/config')
  }
};

export default api;
