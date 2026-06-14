/**
 * OpenClaw Frontend Core - Events v3.0
 * Event bus for component communication
 */

class EventBus {
  constructor() {
    this.events = new Map();
    this.onceEvents = new Map();
  }
  
  // Subscribe to event
  on(event, handler) {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    this.events.get(event).add(handler);
    
    // Return unsubscribe function
    return () => this.off(event, handler);
  }
  
  // Subscribe to event once
  once(event, handler) {
    if (!this.onceEvents.has(event)) {
      this.onceEvents.set(event, new Set());
    }
    this.onceEvents.get(event).add(handler);
    
    return () => this.offOnce(event, handler);
  }
  
  // Unsubscribe from event
  off(event, handler) {
    const handlers = this.events.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.events.delete(event);
      }
    }
  }
  
  // Unsubscribe from once event
  offOnce(event, handler) {
    const handlers = this.onceEvents.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.onceEvents.delete(event);
      }
    }
  }
  
  // Emit event
  emit(event, ...args) {
    // Regular handlers
    const handlers = this.events.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(...args);
        } catch (err) {
          console.error(`Event handler error for ${event}:`, err);
        }
      });
    }
    
    // Once handlers
    const onceHandlers = this.onceEvents.get(event);
    if (onceHandlers) {
      onceHandlers.forEach(handler => {
        try {
          handler(...args);
        } catch (err) {
          console.error(`Once event handler error for ${event}:`, err);
        }
      });
      this.onceEvents.delete(event);
    }
    
    // Wildcard handlers
    const wildcards = this.events.get('*');
    if (wildcards) {
      wildcards.forEach(handler => {
        try {
          handler(event, ...args);
        } catch (err) {
          console.error(`Wildcard event handler error:`, err);
        }
      });
    }
  }
  
  // Emit event asynchronously
  async emitAsync(event, ...args) {
    const promises = [];
    
    const handlers = this.events.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        promises.push(
          Promise.resolve().then(() => handler(...args))
        );
      });
    }
    
    const onceHandlers = this.onceEvents.get(event);
    if (onceHandlers) {
      onceHandlers.forEach(handler => {
        promises.push(
          Promise.resolve().then(() => handler(...args))
        );
      });
      this.onceEvents.delete(event);
    }
    
    await Promise.all(promises);
  }
  
  // Remove all handlers for event
  removeAll(event) {
    if (event) {
      this.events.delete(event);
      this.onceEvents.delete(event);
    } else {
      this.events.clear();
      this.onceEvents.clear();
    }
  }
  
  // Get handler count for event
  listenerCount(event) {
    const regular = this.events.get(event)?.size || 0;
    const once = this.onceEvents.get(event)?.size || 0;
    const wildcards = this.events.get('*')?.size || 0;
    return regular + once + (event !== '*' ? wildcards : 0);
  }
}

// Global event bus
export const events = new EventBus();

// Event names
export const EVENTS = {
  // Navigation
  NAVIGATE: 'navigate',
  ROUTE_CHANGE: 'route:change',
  
  // UI
  SIDEBAR_TOGGLE: 'sidebar:toggle',
  THEME_CHANGE: 'theme:change',
  MODAL_OPEN: 'modal:open',
  MODAL_CLOSE: 'modal:close',
  TOAST_SHOW: 'toast:show',
  
  // Chat
  CHAT_MESSAGE: 'chat:message',
  CHAT_STREAM_START: 'chat:stream:start',
  CHAT_STREAM_CHUNK: 'chat:stream:chunk',
  CHAT_STREAM_END: 'chat:stream:end',
  
  // Code
  CODE_SELECT: 'code:select',
  CODE_EXECUTE: 'code:execute',
  
  // API
  API_REQUEST: 'api:request',
  API_RESPONSE: 'api:response',
  API_ERROR: 'api:error',
  
  // System
  READY: 'app:ready',
  ERROR: 'app:error',
  ONLINE: 'app:online',
  OFFLINE: 'app:offline'
};

// Shortcuts for common events
export const emit = events.emit.bind(events);
export const on = events.on.bind(events);
export const once = events.once.bind(events);
export const off = events.off.bind(events);

export default events;
