/**
 * OpenClaw Layout Components v3.0
 * Container, Grid, Flex layout primitives
 */

const Layout = {
  version: '3.0.0',
  
  // ===== Container Component =====
  Container: class extends Component {
    constructor(options = {}) {
      super();
      this.children = options.children || [];
      this.maxWidth = options.maxWidth || '1200px'; // xs, sm, md, lg, xl, or px value
      this.padding = options.padding || 'md'; // none, sm, md, lg
      this.className = options.className || '';
    }
    
    render() {
      const el = document.createElement('div');
      el.className = `oc-container oc-container--${this.padding} ${this.className}`;
      el.style.maxWidth = this.maxWidth;
      
      this.children.forEach(child => {
        if (typeof child === 'string') {
          el.innerHTML += child;
        } else if (child instanceof HTMLElement) {
          el.appendChild(child);
        } else if (child instanceof Component) {
          el.appendChild(child.mount());
        }
      });
      
      return el;
    }
    
    addChild(child) {
      this.children.push(child);
      this.update();
    }
    
    clear() {
      this.children = [];
      this.update();
    }
  },

  // ===== Grid Component =====
  Grid: class extends Component {
    constructor(options = {}) {
      super();
      this.columns = options.columns || 3; // number or 'auto'
      this.gap = options.gap || 'md'; // none, sm, md, lg
      this.children = options.children || [];
      this.responsive = options.responsive || {
        sm: 1,
        md: 2,
        lg: options.columns || 3
      };
      this.className = options.className || '';
    }
    
    render() {
      const el = document.createElement('div');
      el.className = `oc-grid oc-grid--gap-${this.gap} ${this.className}`;
      
      // Set CSS custom properties for responsive columns
      if (this.columns === 'auto') {
        el.style.gridTemplateColumns = 'repeat(auto-fill, minmax(300px, 1fr))';
      } else {
        el.style.gridTemplateColumns = `repeat(${this.columns}, 1fr)`;
      }
      
      this.children.forEach(child => {
        if (typeof child === 'string') {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = child;
          el.appendChild(wrapper);
        } else if (child instanceof HTMLElement) {
          el.appendChild(child);
        } else if (child instanceof Component) {
          el.appendChild(child.mount());
        }
      });
      
      return el;
    }
    
    addChild(child) {
      this.children.push(child);
      this.update();
    }
  },

  // ===== Flex Component =====
  Flex: class extends Component {
    constructor(options = {}) {
      super();
      this.direction = options.direction || 'row'; // row, column
      this.justify = options.justify || 'start'; // start, center, end, between, around, evenly
      this.align = options.align || 'stretch'; // start, center, end, stretch, baseline
      this.wrap = options.wrap || false;
      this.gap = options.gap || 'md'; // none, sm, md, lg
      this.children = options.children || [];
      this.className = options.className || '';
    }
    
    render() {
      const el = document.createElement('div');
      el.className = `oc-flex oc-flex--${this.direction} oc-flex--justify-${this.justify} oc-flex--align-${this.align} oc-flex--gap-${this.gap} ${this.wrap ? 'oc-flex--wrap' : ''} ${this.className}`;
      
      this.children.forEach(child => {
        if (typeof child === 'string') {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = child;
          el.appendChild(wrapper);
        } else if (child instanceof HTMLElement) {
          el.appendChild(child);
        } else if (child instanceof Component) {
          el.appendChild(child.mount());
        }
      });
      
      return el;
    }
    
    addChild(child) {
      this.children.push(child);
      this.update();
    }
  },

  // ===== Sidebar Layout =====
  SidebarLayout: class extends Component {
    constructor(options = {}) {
      super();
      this.sidebar = options.sidebar || null; // Component or HTMLElement
      this.content = options.content || null;
      this.sidebarWidth = options.sidebarWidth || '280px';
      this.collapsed = options.collapsed || false;
      this.className = options.className || '';
    }
    
    render() {
      const el = document.createElement('div');
      el.className = `oc-layout-sidebar ${this.collapsed ? 'oc-layout-sidebar--collapsed' : ''} ${this.className}`;
      
      const sidebar = document.createElement('aside');
      sidebar.className = 'oc-layout-sidebar__aside';
      sidebar.style.width = this.collapsed ? '60px' : this.sidebarWidth;
      if (this.sidebar) {
        if (this.sidebar instanceof Component) {
          sidebar.appendChild(this.sidebar.mount());
        } else {
          sidebar.appendChild(this.sidebar);
        }
      }
      
      const main = document.createElement('main');
      main.className = 'oc-layout-sidebar__main';
      if (this.content) {
        if (this.content instanceof Component) {
          main.appendChild(this.content.mount());
        } else {
          main.appendChild(this.content);
        }
      }
      
      el.appendChild(sidebar);
      el.appendChild(main);
      
      return el;
    }
    
    toggleSidebar() {
      this.collapsed = !this.collapsed;
      this.update();
    }
  },

  // ===== Split Pane Layout =====
  SplitPane: class extends Component {
    constructor(options = {}) {
      super();
      this.left = options.left || null;
      this.right = options.right || null;
      this.split = options.split || 50; // percentage
      this.direction = options.direction || 'horizontal'; // horizontal, vertical
      this.className = options.className || '';
      this.onResize = options.onResize || (() => {});
    }
    
    render() {
      const el = document.createElement('div');
      el.className = `oc-split-pane oc-split-pane--${this.direction} ${this.className}`;
      
      const leftPane = document.createElement('div');
      leftPane.className = 'oc-split-pane__left';
      leftPane.style.flex = `0 0 ${this.split}%`;
      if (this.left) {
        if (this.left instanceof Component) {
          leftPane.appendChild(this.left.mount());
        } else {
          leftPane.appendChild(this.left);
        }
      }
      
      const resizer = document.createElement('div');
      resizer.className = 'oc-split-pane__resizer';
      
      const rightPane = document.createElement('div');
      rightPane.className = 'oc-split-pane__right';
      if (this.right) {
        if (this.right instanceof Component) {
          rightPane.appendChild(this.right.mount());
        } else {
          rightPane.appendChild(this.right);
        }
      }
      
      // Drag to resize
      let isDragging = false;
      resizer.addEventListener('mousedown', () => { isDragging = true; });
      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const rect = el.getBoundingClientRect();
        const newSplit = this.direction === 'horizontal' 
          ? ((e.clientX - rect.left) / rect.width) * 100
          : ((e.clientY - rect.top) / rect.height) * 100;
        this.split = Math.max(20, Math.min(80, newSplit));
        leftPane.style.flex = `0 0 ${this.split}%`;
        this.onResize(this.split);
      });
      document.addEventListener('mouseup', () => { isDragging = false; });
      
      el.appendChild(leftPane);
      el.appendChild(resizer);
      el.appendChild(rightPane);
      
      return el;
    }
  },

  // ===== Page Header =====
  PageHeader: class extends Component {
    constructor(options = {}) {
      super();
      this.title = options.title || '';
      this.subtitle = options.subtitle || '';
      this.breadcrumbs = options.breadcrumbs || []; // [{ label, href }]
      this.actions = options.actions || []; // Component[] or HTMLElement[]
      this.className = options.className || '';
    }
    
    render() {
      const el = document.createElement('div');
      el.className = `oc-page-header ${this.className}`;
      
      let html = '';
      
      if (this.breadcrumbs.length) {
        html += `<nav class="oc-breadcrumbs">`;
        this.breadcrumbs.forEach((crumb, i) => {
          if (i > 0) html += `<span class="oc-breadcrumbs__sep">/</span>`;
          if (crumb.href) {
            html += `<a href="${crumb.href}" class="oc-breadcrumbs__link">${crumb.label}</a>`;
          } else {
            html += `<span class="oc-breadcrumbs__current">${crumb.label}</span>`;
          }
        });
        html += `</nav>`;
      }
      
      html += `<div class="oc-page-header__main">`;
      html += `<div class="oc-page-header__titles">`;
      html += `<h1 class="oc-page-header__title">${this.title}</h1>`;
      if (this.subtitle) {
        html += `<p class="oc-page-header__subtitle">${this.subtitle}</p>`;
      }
      html += `</div>`;
      
      if (this.actions.length) {
        html += `<div class="oc-page-header__actions"></div>`;
      }
      html += `</div>`;
      
      el.innerHTML = html;
      
      // Append action elements
      const actionsContainer = el.querySelector('.oc-page-header__actions');
      if (actionsContainer) {
        this.actions.forEach(action => {
          if (action instanceof Component) {
            actionsContainer.appendChild(action.mount());
          } else if (action instanceof HTMLElement) {
            actionsContainer.appendChild(action);
          }
        });
      }
      
      return el;
    }
  },

  // ===== Section Component =====
  Section: class extends Component {
    constructor(options = {}) {
      super();
      this.title = options.title || '';
      this.description = options.description || '';
      this.children = options.children || [];
      this.className = options.className || '';
    }
    
    render() {
      const el = document.createElement('section');
      el.className = `oc-section ${this.className}`;
      
      let html = '';
      if (this.title) {
        html += `<h2 class="oc-section__title">${this.title}</h2>`;
      }
      if (this.description) {
        html += `<p class="oc-section__desc">${this.description}</p>`;
      }
      
      const content = document.createElement('div');
      content.className = 'oc-section__content';
      content.innerHTML = html;
      
      this.children.forEach(child => {
        if (typeof child === 'string') {
          const wrapper = document.createElement('div');
          wrapper.innerHTML = child;
          content.appendChild(wrapper);
        } else if (child instanceof HTMLElement) {
          content.appendChild(child);
        } else if (child instanceof Component) {
          content.appendChild(child.mount());
        }
      });
      
      el.appendChild(content);
      return el;
    }
  }
};

// Export to global
window.Layout = Layout;
console.log('✅ Layout Components v3.0 loaded');
