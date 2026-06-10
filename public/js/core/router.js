/**
 * OpenClaw Frontend Core - Router v3.0
 * SPA Router with lazy loading and navigation history
 */

class Router {
  constructor(options = {}) {
    this.routes = new Map();
    this.currentRoute = null;
    this.beforeHooks = [];
    this.afterHooks = [];
    this.base = options.base || '';
    this.mode = options.mode || 'hash';
    this.cache = new Map();
    
    this.init();
  }
  
  init() {
    window.addEventListener('popstate', () => this.handleRoute());
    window.addEventListener('hashchange', () => this.handleRoute());
    
    if (this.mode === 'hash') {
      const hash = location.hash.slice(1) || '/';
      this.navigate(hash, { replace: true });
    } else {
      this.handleRoute();
    }
  }
  
  register(path, config) {
    const paramNames = [];
    const regex = path.replace(/:([^/]+)/g, (match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    
    this.routes.set(path, {
      ...config,
      pattern: new RegExp(`^${regex}$`),
      paramNames,
      path
    });
    return this;
  }
  
  registerRoutes(routes) {
    Object.entries(routes).forEach(([path, config]) => {
      this.register(path, config);
    });
    return this;
  }
  
  navigate(to, options = {}) {
    const { replace = false, state = null, skipHooks = false } = options;
    const url = this.base + to;
    
    if (this.mode === 'history') {
      if (replace) {
        history.replaceState(state, '', url);
      } else {
        history.pushState(state, '', url);
      }
    } else {
      if (replace) {
        location.replace(`#${to}`);
      } else {
        location.hash = to;
      }
    }
    
    return this.handleRoute(skipHooks);
  }
  
  async handleRoute(skipHooks = false) {
    const path = this.mode === 'history' 
      ? location.pathname + location.search
      : location.hash.slice(1) || '/';
    
    const matched = this.matchRoute(path);
    
    if (!matched) {
      console.warn(`No route matched: ${path}`);
      if (this.routes.has('/404')) {
        return this.navigate('/404', { replace: true });
      }
      return null;
    }
    
    const { route, params } = matched;
    
    if (!skipHooks) {
      for (const hook of this.beforeHooks) {
        const result = await hook(route, this.currentRoute, { params });
        if (result === false) return null;
      }
    }
    
    let component = this.cache.get(route.path);
    if (!component) {
      if (route.lazy && route.loader) {
        component = await route.loader();
      } else {
        component = route.component;
      }
      if (route.cache !== false) {
        this.cache.set(route.path, component);
      }
    }
    
    const previousRoute = this.currentRoute;
    this.currentRoute = {
      path: route.path,
      params,
      component,
      meta: route.meta || {},
      title: route.title
    };
    
    if (route.title) {
      document.title = route.title + ' | OpenClaw';
    }
    
    this.render(component, { params, route: this.currentRoute });
    
    if (!skipHooks) {
      for (const hook of this.afterHooks) {
        await hook(this.currentRoute, previousRoute, { params });
      }
    }
    
    if (route.onEnter) {
      await route.onEnter(this.currentRoute, { params });
    }
    
    return this.currentRoute;
  }
  
  matchRoute(path) {
    const cleanPath = path.split('?')[0];
    
    for (const [routePath, route] of this.routes) {
      const match = cleanPath.match(route.pattern);
      if (match) {
        const params = {};
        route.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
        return { route, params };
      }
    }
    
    return null;
  }
  
  render(component, context) {
    const container = document.getElementById('app-content');
    if (!container) return;
    
    document.querySelectorAll('.page').forEach(el => {
      el.classList.add('hidden');
      el.classList.remove('active');
    });
    
    const pageId = `page-${context.route.path.slice(1) || 'home'}`;
    let pageEl = document.getElementById(pageId);
    
    if (!pageEl) {
      pageEl = document.createElement('div');
      pageEl.id = pageId;
      pageEl.className = 'page';
      container.appendChild(pageEl);
    }
    
    if (typeof component === 'function') {
      const instance = new component(context);
      pageEl.innerHTML = instance.render();
      if (instance.mount) instance.mount(pageEl);
    } else if (typeof component === 'string') {
      pageEl.innerHTML = component;
    } else if (component && component.render) {
      pageEl.innerHTML = component.render(context);
      if (component.mount) component.mount(pageEl);
    }
    
    pageEl.classList.remove('hidden');
    pageEl.classList.add('active');
    pageEl.scrollTop = 0;
  }
  
  beforeEach(fn) {
    this.beforeHooks.push(fn);
    return this;
  }
  
  afterEach(fn) {
    this.afterHooks.push(fn);
    return this;
  }
  
  back() {
    history.back();
  }
  
  forward() {
    history.forward();
  }
  
  getCurrentRoute() {
    return this.currentRoute;
  }
}

// Base Component class
class Component {
  constructor(props = {}) {
    this.props = props;
    this.state = {};
    this.el = null;
    this.eventBindings = [];
  }
  
  setState(newState) {
    Object.assign(this.state, newState);
    this.update();
  }
  
  render() {
    return '<div>Base Component</div>';
  }
  
  mount(el) {
    this.el = el;
    this.bindEvents();
  }
  
  unmount() {
    this.unbindEvents();
    this.el = null;
  }
  
  update() {
    if (this.el) {
      this.unbindEvents();
      this.el.innerHTML = this.render();
      this.bindEvents();
    }
  }
  
  bindEvents() {
    const events = this.events ? this.events() : {};
    Object.entries(events).forEach(([key, handler]) => {
      const parts = key.split(' ');
      const event = parts[0];
      const selector = parts.slice(1).join(' ');
      const elements = selector ? this.el.querySelectorAll(selector) : [this.el];
      
      elements.forEach(el => {
        const bound = handler.bind(this);
        el.addEventListener(event, bound);
        this.eventBindings.push({ el, event, bound });
      });
    });
  }
  
  unbindEvents() {
    this.eventBindings.forEach(({ el, event, bound }) => {
      el.removeEventListener(event, bound);
    });
    this.eventBindings = [];
  }
}

export { Router, Component };
export default Router;
