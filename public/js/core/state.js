/**
 * OpenClaw Frontend Core - State v3.0
 * Reactive state management with computed properties and subscriptions
 */

class Store {
  constructor(initialState = {}) {
    this.state = this.createProxy(initialState);
    this.subscribers = new Map();
    this.computed = new Map();
    this.batchQueue = [];
    this.isBatching = false;
  }
  
  // Create reactive proxy
  createProxy(obj, path = '') {
    const self = this;
    
    return new Proxy(obj, {
      get(target, key) {
        const value = target[key];
        if (typeof value === 'object' && value !== null) {
          return self.createProxy(value, path ? `${path}.${key}` : key);
        }
        return value;
      },
      
      set(target, key, value) {
        const oldValue = target[key];
        if (oldValue === value) return true;
        
        target[key] = value;
        const fullPath = path ? `${path}.${key}` : key;
        
        self.notify(fullPath, value, oldValue);
        return true;
      },
      
      deleteProperty(target, key) {
        const oldValue = target[key];
        delete target[key];
        const fullPath = path ? `${path}.${key}` : key;
        self.notify(fullPath, undefined, oldValue);
        return true;
      }
    });
  }
  
  // Subscribe to state changes
  subscribe(path, callback, options = {}) {
    const { immediate = false, deep = false } = options;
    
    if (!this.subscribers.has(path)) {
      this.subscribers.set(path, new Set());
    }
    
    this.subscribers.get(path).add({ callback, deep });
    
    if (immediate) {
      const value = this.get(path);
      callback(value, undefined);
    }
    
    // Return unsubscribe function
    return () => {
      this.subscribers.get(path)?.delete(callback);
    };
  }
  
  // Notify subscribers
  notify(path, newValue, oldValue) {
    if (this.isBatching) {
      this.batchQueue.push({ path, newValue, oldValue });
      return;
    }
    
    // Notify exact path subscribers
    const exact = this.subscribers.get(path);
    if (exact) {
      exact.forEach(({ callback }) => {
        try {
          callback(newValue, oldValue);
        } catch (err) {
          console.error('Subscriber error:', err);
        }
      });
    }
    
    // Notify parent path subscribers
    const parts = path.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const parentPath = parts.slice(0, i).join('.');
      const parent = this.subscribers.get(parentPath);
      if (parent) {
        parent.forEach(({ callback, deep }) => {
          if (deep) {
            try {
              callback(this.get(parentPath), this.get(parentPath));
            } catch (err) {
              console.error('Deep subscriber error:', err);
            }
          }
        });
      }
    }
    
    // Notify wildcard subscribers
    const wildcard = this.subscribers.get('*');
    if (wildcard) {
      wildcard.forEach(({ callback }) => {
        try {
          callback({ path, newValue, oldValue }, this.state);
        } catch (err) {
          console.error('Wildcard subscriber error:', err);
        }
      });
    }
  }
  
  // Flush batched updates
  flush() {
    this.isBatching = false;
    const queue = [...this.batchQueue];
    this.batchQueue = [];
    queue.forEach(({ path, newValue, oldValue }) => {
      this.notify(path, newValue, oldValue);
    });
  }
  
  // Batch multiple updates
  batch(fn) {
    this.isBatching = true;
    try {
      fn();
    } finally {
      this.flush();
    }
  }
  
  // Get state value by path
  get(path) {
    if (!path) return this.state;
    
    const parts = path.split('.');
    let value = this.state;
    
    for (const part of parts) {
      if (value === null || value === undefined) return undefined;
      value = value[part];
    }
    
    return value;
  }
  
  // Set state value by path
  set(path, value) {
    const parts = path.split('.');
    let target = this.state;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in target) || typeof target[part] !== 'object') {
        target[part] = {};
      }
      target = target[part];
    }
    
    target[parts[parts.length - 1]] = value;
    return this;
  }
  
  // Merge state
  merge(path, values) {
    const current = this.get(path) || {};
    this.set(path, { ...current, ...values });
    return this;
  }
  
  // Delete state
  delete(path) {
    const parts = path.split('.');
    let target = this.state;
    
    for (let i = 0; i < parts.length - 1; i++) {
      target = target?.[parts[i]];
      if (!target) return;
    }
    
    delete target[parts[parts.length - 1]];
  }
  
  // Computed property
  computed(name, fn) {
    let cachedValue;
    let isDirty = true;
    
    const computed = () => {
      if (isDirty) {
        cachedValue = fn(this.state);
        isDirty = false;
      }
      return cachedValue;
    };
    
    computed.invalidate = () => { isDirty = true; };
    this.computed.set(name, computed);
    
    // Subscribe to all changes
    this.subscribe('*', () => { isDirty = true; });
    
    return computed;
  }
  
  // Action dispatcher
  dispatch(action, payload) {
    if (this.actions && this.actions[action]) {
      return this.actions[action](this, payload);
    }
    throw new Error(`Unknown action: ${action}`);
  }
  
  // Reset state
  reset(newState = {}) {
    Object.keys(this.state).forEach(key => {
      delete this.state[key];
    });
    Object.assign(this.state, newState);
    return this;
  }
  
  // Persist state to localStorage
  persist(keys, options = {}) {
    const { storageKey = 'store', debounce = 100 } = options;
    
    // Load persisted state
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.batch(() => {
          keys.forEach(key => {
            if (parsed[key] !== undefined) {
              this.set(key, parsed[key]);
            }
          });
        });
      }
    } catch (err) {
      console.warn('Failed to load persisted state:', err);
    }
    
    // Subscribe to changes
    let debounceTimer;
    keys.forEach(key => {
      this.subscribe(key, () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            const toSave = {};
            keys.forEach(k => toSave[k] = this.get(k));
            localStorage.setItem(storageKey, JSON.stringify(toSave));
          } catch (err) {
            console.warn('Failed to persist state:', err);
          }
        }, debounce);
      });
    });
    
    return this;
  }
}

// Create global store
export const store = new Store({
  theme: 'dark',
  sidebarOpen: window.innerWidth > 768,
  currentPage: 'chat',
  user: null,
  notifications: [],
  apiStatus: {},
  perfData: {},
  router: {
    current: '/',
    params: {},
    history: []
  }
});

// Computed properties
export const isDarkMode = () => store.get('theme') === 'dark';
export const isMobile = () => window.innerWidth <= 768;
export const isAuthenticated = () => !!store.get('user');

// Actions
store.actions = {
  toggleTheme: (store) => {
    const current = store.get('theme');
    const next = current === 'dark' ? 'light' : 'dark';
    store.set('theme', next);
    document.documentElement.setAttribute('data-theme', next);
  },
  
  toggleSidebar: (store) => {
    store.set('sidebarOpen', !store.get('sidebarOpen'));
  },
  
  navigate: (store, page) => {
    store.batch(() => {
      store.set('currentPage', page);
      store.merge('router', {
        current: page,
        history: [...store.get('router.history'), page].slice(-10)
      });
    });
  },
  
  addNotification: (store, notification) => {
    const id = Date.now().toString(36);
    const notifications = store.get('notifications');
    store.set('notifications', [...notifications, { id, ...notification }]);
    
    // Auto remove
    setTimeout(() => {
      store.actions.removeNotification(store, id);
    }, notification.duration || 5000);
    
    return id;
  },
  
  removeNotification: (store, id) => {
    const notifications = store.get('notifications');
    store.set('notifications', notifications.filter(n => n.id !== id));
  },
  
  updateApiStatus: (store, status) => {
    store.merge('apiStatus', status);
  },
  
  updatePerfData: (store, data) => {
    store.set('perfData', data);
  }
};

// Persist theme preference
store.persist(['theme'], { storageKey: 'openclaw-store' });

// Apply theme on load
if (store.get('theme') === 'light') {
  document.documentElement.setAttribute('data-theme', 'light');
}

export { Store };
