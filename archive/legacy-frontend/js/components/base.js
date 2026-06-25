/**
 * OpenClaw UI Component Library v3.0
 * Base Components: Button, Card, Modal, Input, Toast
 * 
 * Design: Minimal, consistent, accessible
 * Dependencies: js/core/events.js (EventBus), js/utils/dom.js (DOM)
 */

const UI = {
  version: '3.0.0',
  
  // ===== Button Component =====
  Button: class extends globalThis.Component {
    constructor(options = {}) {
      super();
      this.text = options.text || '';
      this.type = options.type || 'primary'; // primary, secondary, danger, ghost
      this.size = options.size || 'md'; // sm, md, lg
      this.icon = options.icon || null;
      this.loading = false;
      this.disabled = false;
      this.onClick = options.onClick || (() => {});
      this.className = options.className || '';
    }
    
    render() {
      const el = document.createElement('button');
      el.className = `oc-btn oc-btn--${this.type} oc-btn--${this.size} ${this.className}`;
      el.disabled = this.disabled || this.loading;
      
      if (this.loading) {
        el.innerHTML = `<span class="oc-spinner oc-spinner--sm"></span> ${this.text}`;
      } else if (this.icon) {
        el.innerHTML = `<span class="oc-icon">${this.icon}</span> ${this.text}`;
      } else {
        el.textContent = this.text;
      }
      
      el.addEventListener('click', (e) => {
        if (!this.disabled && !this.loading) {
          this.onClick(e);
        }
      });
      
      return el;
    }
    
    setLoading(loading) {
      this.loading = loading;
      this.update();
    }
    
    setDisabled(disabled) {
      this.disabled = disabled;
      this.update();
    }
  },

  // ===== Card Component =====
  Card: class extends globalThis.Component {
    constructor(options = {}) {
      super();
      this.title = options.title || '';
      this.subtitle = options.subtitle || '';
      this.content = options.content || '';
      this.footer = options.footer || null;
      this.actions = options.actions || []; // [{ text, type, onClick }]
      this.loading = false;
      this.className = options.className || '';
    }
    
    render() {
      const el = document.createElement('div');
      el.className = `oc-card ${this.className}`;
      
      if (this.loading) {
        el.classList.add('oc-card--loading');
      }
      
      let html = '';
      
      if (this.title) {
        html += `<div class="oc-card__header">
          <div class="oc-card__title">${this.title}</div>
          ${this.subtitle ? `<div class="oc-card__subtitle">${this.subtitle}</div>` : ''}
        </div>`;
      }
      
      html += `<div class="oc-card__body">${this.content}</div>`;
      
      if (this.actions.length || this.footer) {
        html += `<div class="oc-card__footer">`;
        if (this.footer) {
          html += `<span class="oc-card__footer-text">${this.footer}</span>`;
        }
        this.actions.forEach(action => {
          html += `<button class="oc-btn oc-btn--${action.type || 'secondary'} oc-btn--sm" data-action="${action.text}">${action.text}</button>`;
        });
        html += `</div>`;
      }
      
      el.innerHTML = html;
      
      // Bind action clicks
      el.querySelectorAll('[data-action]').forEach(btn => {
        const action = this.actions.find(a => a.text === btn.dataset.action);
        if (action) {
          btn.addEventListener('click', action.onClick);
        }
      });
      
      return el;
    }
    
    setContent(content) {
      this.content = content;
      this.update();
    }
    
    setLoading(loading) {
      this.loading = loading;
      this.update();
    }
  },

  // ===== Modal Component =====
  Modal: class extends globalThis.Component {
    constructor(options = {}) {
      super();
      this.title = options.title || '';
      this.content = options.content || '';
      this.size = options.size || 'md'; // sm, md, lg, xl, full
      this.closable = options.closable !== false;
      this.backdropClosable = options.backdropClosable !== false;
      this.onClose = options.onClose || (() => {});
      this.onConfirm = options.onConfirm || null;
      this.confirmText = options.confirmText || '确认';
      this.cancelText = options.cancelText || '取消';
      this.visible = false;
    }
    
    render() {
      if (!this.visible) return document.createElement('div');
      
      const overlay = document.createElement('div');
      overlay.className = 'oc-modal-overlay';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay && this.backdropClosable) {
          this.close();
        }
      });
      
      const modal = document.createElement('div');
      modal.className = `oc-modal oc-modal--${this.size}`;
      
      let html = `<div class="oc-modal__header">
        <h3 class="oc-modal__title">${this.title}</h3>
        ${this.closable ? '<button class="oc-modal__close">&times;</button>' : ''}
      </div>`;
      
      html += `<div class="oc-modal__body">${this.content}</div>`;
      
      if (this.onConfirm) {
        html += `<div class="oc-modal__footer">
          <button class="oc-btn oc-btn--secondary oc-modal__cancel">${this.cancelText}</button>
          <button class="oc-btn oc-btn--primary oc-modal__confirm">${this.confirmText}</button>
        </div>`;
      }
      
      modal.innerHTML = html;
      overlay.appendChild(modal);
      
      // Event bindings
      if (this.closable) {
        modal.querySelector('.oc-modal__close').addEventListener('click', () => this.close());
      }
      if (this.onConfirm) {
        modal.querySelector('.oc-modal__cancel').addEventListener('click', () => this.close());
        modal.querySelector('.oc-modal__confirm').addEventListener('click', () => {
          this.onConfirm();
          this.close();
        });
      }
      
      // Escape to close
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          this.close();
          document.removeEventListener('keydown', escHandler);
        }
      };
      document.addEventListener('keydown', escHandler);
      
      return overlay;
    }
    
    open() {
      this.visible = true;
      document.body.style.overflow = 'hidden';
      this.update();
    }
    
    close() {
      this.visible = false;
      document.body.style.overflow = '';
      this.onClose();
      this.update();
    }
    
    setContent(content) {
      this.content = content;
      if (this.visible) this.update();
    }
  },

  // ===== Input Component =====
  Input: class extends globalThis.Component {
    constructor(options = {}) {
      super();
      this.type = options.type || 'text'; // text, password, number, textarea, select
      this.label = options.label || '';
      this.placeholder = options.placeholder || '';
      this.value = options.value || '';
      this.error = options.error || '';
      this.disabled = options.disabled || false;
      this.options = options.options || []; // for select
      this.onChange = options.onChange || (() => {});
      this.onEnter = options.onEnter || null;
      this.className = options.className || '';
    }
    
    render() {
      const wrapper = document.createElement('div');
      wrapper.className = `oc-input-wrapper ${this.error ? 'oc-input--error' : ''} ${this.className}`;
      
      let html = '';
      if (this.label) {
        html += `<label class="oc-input__label">${this.label}</label>`;
      }
      
      if (this.type === 'textarea') {
        html += `<textarea class="oc-input oc-input--textarea" placeholder="${this.placeholder}" ${this.disabled ? 'disabled' : ''}>${this.value}</textarea>`;
      } else if (this.type === 'select') {
        html += `<select class="oc-input oc-input--select" ${this.disabled ? 'disabled' : ''}>`;
        this.options.forEach(opt => {
          html += `<option value="${opt.value}" ${opt.value === this.value ? 'selected' : ''}>${opt.label}</option>`;
        });
        html += `</select>`;
      } else {
        html += `<input type="${this.type}" class="oc-input" placeholder="${this.placeholder}" value="${this.value}" ${this.disabled ? 'disabled' : ''}>`;
      }
      
      if (this.error) {
        html += `<span class="oc-input__error">${this.error}</span>`;
      }
      
      wrapper.innerHTML = html;
      
      const inputEl = wrapper.querySelector('.oc-input');
      inputEl.addEventListener('input', (e) => {
        this.value = e.target.value;
        this.onChange(this.value);
      });
      
      if (this.onEnter) {
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.onEnter(this.value);
          }
        });
      }
      
      return wrapper;
    }
    
    setValue(value) {
      this.value = value;
      this.update();
    }
    
    setError(error) {
      this.error = error;
      this.update();
    }
    
    focus() {
      const el = this.element?.querySelector('.oc-input');
      if (el) el.focus();
    }
  },

  // ===== Toast Component =====
  Toast: {
    container: null,
    toasts: [],
    
    init() {
      if (!this.container) {
        this.container = document.createElement('div');
        this.container.className = 'oc-toast-container';
        document.body.appendChild(this.container);
      }
    },
    
    show(message, type = 'info', duration = 3000) {
      this.init();
      
      const toast = document.createElement('div');
      toast.className = `oc-toast oc-toast--${type}`;
      toast.innerHTML = `
        <span class="oc-toast__icon">${this.getIcon(type)}</span>
        <span class="oc-toast__message">${message}</span>
        <button class="oc-toast__close">&times;</button>
      `;
      
      const closeBtn = toast.querySelector('.oc-toast__close');
      closeBtn.addEventListener('click', () => this.remove(toast));
      
      this.container.appendChild(toast);
      
      // Animate in
      requestAnimationFrame(() => {
        toast.classList.add('oc-toast--visible');
      });
      
      // Auto dismiss
      if (duration > 0) {
        setTimeout(() => this.remove(toast), duration);
      }
      
      return toast;
    },
    
    remove(toast) {
      toast.classList.remove('oc-toast--visible');
      toast.addEventListener('transitionend', () => {
        toast.remove();
      });
    },
    
    getIcon(type) {
      const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ'
      };
      return icons[type] || icons.info;
    },
    
    success(message, duration) {
      return this.show(message, 'success', duration);
    },
    
    error(message, duration) {
      return this.show(message, 'error', duration);
    },
    
    warning(message, duration) {
      return this.show(message, 'warning', duration);
    },
    
    info(message, duration) {
      return this.show(message, 'info', duration);
    }
  },

  // ===== Loading/Spinner =====
  Loading: {
    show(text = '加载中...') {
      let overlay = document.getElementById('oc-loading-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'oc-loading-overlay';
        overlay.className = 'oc-loading-overlay';
        overlay.innerHTML = `
          <div class="oc-loading">
            <div class="oc-spinner oc-spinner--lg"></div>
            <div class="oc-loading__text">${text}</div>
          </div>
        `;
        document.body.appendChild(overlay);
      }
    },
    
    hide() {
      const overlay = document.getElementById('oc-loading-overlay');
      if (overlay) {
        overlay.classList.add('oc-loading-overlay--fade');
        setTimeout(() => overlay.remove(), 300);
      }
    }
  },

  // ===== Badge Component =====
  Badge: class extends globalThis.Component {
    constructor(options = {}) {
      super();
      this.text = options.text || '';
      this.type = options.type || 'default'; // default, success, warning, error, info
      this.dot = options.dot || false;
    }
    
    render() {
      const el = document.createElement('span');
      el.className = `oc-badge oc-badge--${this.type}`;
      if (this.dot) {
        el.innerHTML = `<span class="oc-badge__dot"></span> ${this.text}`;
      } else {
        el.textContent = this.text;
      }
      return el;
    }
  },

  // ===== Tabs Component =====
  Tabs: class extends globalThis.Component {
    constructor(options = {}) {
      super();
      this.tabs = options.tabs || []; // [{ id, label, content }]
      this.activeTab = options.activeTab || (this.tabs[0]?.id || '');
      this.onChange = options.onChange || (() => {});
    }
    
    render() {
      const el = document.createElement('div');
      el.className = 'oc-tabs';
      
      const nav = document.createElement('div');
      nav.className = 'oc-tabs__nav';
      
      this.tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.className = `oc-tabs__tab ${tab.id === this.activeTab ? 'oc-tabs__tab--active' : ''}`;
        btn.textContent = tab.label;
        btn.addEventListener('click', () => {
          this.activeTab = tab.id;
          this.onChange(tab.id);
          this.update();
        });
        nav.appendChild(btn);
      });
      
      const content = document.createElement('div');
      content.className = 'oc-tabs__content';
      const activeTab = this.tabs.find(t => t.id === this.activeTab);
      if (activeTab) {
        content.innerHTML = activeTab.content;
      }
      
      el.appendChild(nav);
      el.appendChild(content);
      return el;
    }
    
    setActiveTab(tabId) {
      this.activeTab = tabId;
      this.update();
    }
  },

  // ===== Empty State Component =====
  EmptyState: class extends Component {
    constructor(options = {}) {
      super();
      this.icon = options.icon || '📭';
      this.title = options.title || '暂无数据';
      this.description = options.description || '';
      this.action = options.action || null; // { text, onClick }
    }
    
    render() {
      const el = document.createElement('div');
      el.className = 'oc-empty';
      el.innerHTML = `
        <div class="oc-empty__icon">${this.icon}</div>
        <div class="oc-empty__title">${this.title}</div>
        ${this.description ? `<div class="oc-empty__desc">${this.description}</div>` : ''}
        ${this.action ? `<button class="oc-btn oc-btn--primary">${this.action.text}</button>` : ''}
      `;
      
      if (this.action) {
        el.querySelector('.oc-btn').addEventListener('click', this.action.onClick);
      }
      
      return el;
    }
  }
};

// Export to global
window.UI = UI;
console.log('✅ UI Component Library v3.0 loaded');
