/**
 * OpenClaw Page Templates v3.0
 * Base Page class and specific page templates
 */

// Pre-declare placeholder so self-references via globalThis.Pages work in ESM (TDZ-safe)
// window.Pages = window.Pages || {};

const Pages = {
  version: '3.0.0',

  // ===== Base Page Class =====
  Page: class extends globalThis.Component {
    constructor(options = {}) {
      super();
      this.pageId = options.pageId || '';
      this.pageTitle = options.pageTitle || '';
      this.pageIcon = options.pageIcon || '';
      this.sidebar = options.sidebar || null;
      this.toolbar = options.toolbar || null;
      this.content = options.content || null;
      this.loading = false;
      this.error = null;
    }
    
    render() {
      const el = document.createElement('div');
      el.className = `oc-page oc-page--${this.pageId}`;
      el.dataset.page = this.pageId;
      
      // Loading state
      if (this.loading) {
        el.innerHTML = `
          <div class="oc-page__loading">
            <div class="oc-spinner oc-spinner--lg"></div>
            <p>加载中...</p>
          </div>
        `;
        return el;
      }
      
      // Error state
      if (this.error) {
        el.innerHTML = `
          <div class="oc-page__error">
            <div class="oc-empty__icon">⚠️</div>
            <div class="oc-empty__title">加载失败</div>
            <div class="oc-empty__desc">${this.error}</div>
            <button class="oc-btn oc-btn--primary" onclick="location.reload()">刷新页面</button>
          </div>
        `;
        return el;
      }
      
      // Normal state
      if (this.toolbar) {
        const toolbarEl = document.createElement('div');
        toolbarEl.className = 'oc-page__toolbar';
        if (this.toolbar instanceof Component) {
          toolbarEl.appendChild(this.toolbar.mount());
        } else {
          toolbarEl.appendChild(this.toolbar);
        }
        el.appendChild(toolbarEl);
      }
      
      if (this.sidebar || this.content) {
        const bodyEl = document.createElement('div');
        bodyEl.className = 'oc-page__body';
        
        if (this.sidebar) {
          const sidebarEl = document.createElement('aside');
          sidebarEl.className = 'oc-page__sidebar';
          if (this.sidebar instanceof Component) {
            sidebarEl.appendChild(this.sidebar.mount());
          } else {
            sidebarEl.appendChild(this.sidebar);
          }
          bodyEl.appendChild(sidebarEl);
        }
        
        if (this.content) {
          const contentEl = document.createElement('main');
          contentEl.className = 'oc-page__content';
          if (this.content instanceof Component) {
            contentEl.appendChild(this.content.mount());
          } else {
            contentEl.appendChild(this.content);
          }
          bodyEl.appendChild(contentEl);
        }
        
        el.appendChild(bodyEl);
      }
      
      return el;
    }
    
    setLoading(loading) {
      this.loading = loading;
      this.update();
    }
    
    setError(error) {
      this.error = error;
      this.loading = false;
      this.update();
    }
    
    setContent(content) {
      this.content = content;
      this.update();
    }
  },

  // ===== Chat Page Template =====
  ChatPage: class extends globalThis.Component {
    constructor(options = {}) {
      super({
        pageId: 'chat',
        pageTitle: '聊天',
        pageIcon: '💬',
        ...options
      });
      this.messages = options.messages || [];
      this.inputPlaceholder = options.inputPlaceholder || '输入消息...';
      this.onSend = options.onSend || (() => {});
      this.onModelChange = options.onModelChange || (() => {});
      this.models = options.models || [];
      this.selectedModel = options.selectedModel || '';
    }
    
    render() {
      const el = super.render();
      if (this.loading || this.error) return el;
      
      // Override content with chat-specific layout
      const chatLayout = document.createElement('div');
      chatLayout.className = 'oc-chat-layout';
      
      // Messages area
      const messagesArea = document.createElement('div');
      messagesArea.className = 'oc-chat-messages';
      this.messages.forEach(msg => {
        const msgEl = document.createElement('div');
        msgEl.className = `oc-chat-message oc-chat-message--${msg.role}`;
        msgEl.innerHTML = `
          <div class="oc-chat-message__avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
          <div class="oc-chat-message__content">
            <div class="oc-chat-message__text">${msg.content}</div>
            ${msg.model ? `<div class="oc-chat-message__meta">${msg.model} · ${msg.time || ''}</div>` : ''}
          </div>
        `;
        messagesArea.appendChild(msgEl);
      });
      
      // Scroll to bottom
      requestAnimationFrame(() => {
        messagesArea.scrollTop = messagesArea.scrollHeight;
      });
      
      // Input area
      const inputArea = document.createElement('div');
      inputArea.className = 'oc-chat-input';
      inputArea.innerHTML = `
        <select class="oc-input oc-input--select oc-chat-model-select">
          ${this.models.map(m => `<option value="${m.id}" ${m.id === this.selectedModel ? 'selected' : ''}>${m.name}</option>
          `).join('')}
        </select>
        <div class="oc-chat-input__box">
          <textarea class="oc-input oc-input--textarea oc-chat-textarea" placeholder="${this.inputPlaceholder}" rows="1"></textarea>
          <button class="oc-btn oc-btn--primary oc-chat-send">发送</button>
        </div>
      `;
      
      const modelSelect = inputArea.querySelector('.oc-chat-model-select');
      modelSelect.addEventListener('change', (e) => this.onModelChange(e.target.value));
      
      const textarea = inputArea.querySelector('.oc-chat-textarea');
      const sendBtn = inputArea.querySelector('.oc-chat-send');
      
      const sendMessage = () => {
        const text = textarea.value.trim();
        if (text) {
          this.onSend(text, modelSelect.value);
          textarea.value = '';
        }
      };
      
      sendBtn.addEventListener('click', sendMessage);
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      
      chatLayout.appendChild(messagesArea);
      chatLayout.appendChild(inputArea);
      
      // Clear and add chat layout
      el.innerHTML = '';
      el.appendChild(chatLayout);
      
      return el;
    }
    
    addMessage(message) {
      this.messages.push(message);
      this.update();
    }
    
    clearMessages() {
      this.messages = [];
      this.update();
    }
  },

  // ===== Code Page Template =====
  CodePage: class extends globalThis.Component {
    constructor(options = {}) {
      super({
        pageId: 'code',
        pageTitle: '代码',
        pageIcon: '💻',
        ...options
      });
      this.files = options.files || [];
      this.selectedFile = options.selectedFile || null;
      this.onFileSelect = options.onFileSelect || (() => {});
      this.onSearch = options.onSearch || (() => {});
      this.onIndex = options.onIndex || (() => {});
    }
    
    render() {
      const el = super.render();
      if (this.loading || this.error) return el;
      
      const layout = document.createElement('div');
      layout.className = 'oc-code-layout';
      
      // Sidebar - File tree
      const sidebar = document.createElement('div');
      sidebar.className = 'oc-code-sidebar';
      sidebar.innerHTML = `
        <div class="oc-code-sidebar__header">
          <input type="text" class="oc-input oc-code-search" placeholder="搜索文件...">
          <button class="oc-btn oc-btn--sm oc-code-index-btn">🔄 索引</button>
        </div>
        <div class="oc-code-filetree"></div>
      `;
      
      const searchInput = sidebar.querySelector('.oc-code-search');
      searchInput.addEventListener('input', (e) => {
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => this.onSearch(e.target.value), 300);
      });
      
      sidebar.querySelector('.oc-code-index-btn').addEventListener('click', () => this.onIndex());
      
      const fileTree = sidebar.querySelector('.oc-code-filetree');
      this.renderFileTree(fileTree, this.files);
      
      // Content - Code view
      const content = document.createElement('div');
      content.className = 'oc-code-content';
      
      if (this.selectedFile) {
        content.innerHTML = `
          <div class="oc-code-header">
            <span class="oc-code-filename">${this.selectedFile.name}</span>
            <span class="oc-badge">${this.selectedFile.language || 'text'}</span>
          </div>
          <pre class="oc-code-view"><code>${this.escapeHtml(this.selectedFile.content || '')}</code></pre>
        `;
      } else {
        content.innerHTML = `
          <div class="oc-empty">
            <div class="oc-empty__icon">📁</div>
            <div class="oc-empty__title">选择文件查看代码</div>
          </div>
        `;
      }
      
      layout.appendChild(sidebar);
      layout.appendChild(content);
      
      el.innerHTML = '';
      el.appendChild(layout);
      
      return el;
    }
    
    renderFileTree(container, files, level = 0) {
      files.forEach(file => {
        const item = document.createElement('div');
        item.className = `oc-code-fileitem ${file.type} ${file === this.selectedFile ? 'active' : ''}`;
        item.style.paddingLeft = `${level * 16 + 12}px`;
        item.innerHTML = `
          <span class="oc-code-fileicon">${file.type === 'folder' ? '📁' : '📄'}</span>
          <span class="oc-code-filename">${file.name}</span>
        `;
        item.addEventListener('click', () => {
          if (file.type === 'file') {
            this.selectedFile = file;
            this.onFileSelect(file);
            this.update();
          }
        });
        container.appendChild(item);
        
        if (file.children) {
          this.renderFileTree(container, file.children, level + 1);
        }
      });
    }
    
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    setFiles(files) {
      this.files = files;
      this.update();
    }
  },

  // ===== Agents Page Template =====
  AgentsPage: class extends globalThis.Component {
    constructor(options = {}) {
      super({
        pageId: 'agents',
        pageTitle: '智能体',
        pageIcon: '🤖',
        ...options
      });
      this.agents = options.agents || [
        { id: 'generate', name: '代码生成', icon: '✨', desc: '根据描述生成代码' },
        { id: 'refactor', name: '代码重构', icon: '🔧', desc: '优化和改进代码结构' },
        { id: 'review', name: '代码审查', icon: '🔍', desc: '检查代码质量和问题' },
        { id: 'test', name: '测试生成', icon: '🧪', desc: '自动生成测试用例' }
      ];
      this.activeAgent = options.activeAgent || null;
      this.onAgentSelect = options.onAgentSelect || (() => {});
      this.onExecute = options.onExecute || (() => {});
    }
    
    render() {
      const el = super.render();
      if (this.loading || this.error) return el;
      
      const layout = document.createElement('div');
      layout.className = 'oc-agents-layout';
      
      if (!this.activeAgent) {
        // Agent selection grid
        const grid = document.createElement('div');
        grid.className = 'oc-agents-grid';
        
        this.agents.forEach(agent => {
          const card = document.createElement('div');
          card.className = 'oc-agent-card';
          card.innerHTML = `
            <div class="oc-agent-card__icon">${agent.icon}</div>
            <div class="oc-agent-card__name">${agent.name}</div>
            <div class="oc-agent-card__desc">${agent.desc}</div>
          `;
          card.addEventListener('click', () => {
            this.activeAgent = agent;
            this.onAgentSelect(agent);
            this.update();
          });
          grid.appendChild(card);
        });
        
        layout.appendChild(grid);
      } else {
        // Agent execution interface
        const agentInterface = document.createElement('div');
        agentInterface.className = 'oc-agent-interface';
        agentInterface.innerHTML = `
          <div class="oc-agent-header">
            <button class="oc-btn oc-btn--ghost oc-agent-back">← 返回</button>
            <span class="oc-agent-header__title">${this.activeAgent.icon} ${this.activeAgent.name}</span>
          </div>
          <div class="oc-agent-workspace">
            <div class="oc-agent-input-area">
              <textarea class="oc-input oc-input--textarea oc-agent-prompt" placeholder="描述你的需求..." rows="6"></textarea>
              <div class="oc-agent-actions">
                <button class="oc-btn oc-btn--secondary oc-agent-clear">清空</button>
                <button class="oc-btn oc-btn--primary oc-agent-run">🚀 执行</button>
              </div>
            </div>
            <div class="oc-agent-output">
              <div class="oc-empty">
                <div class="oc-empty__icon">📝</div>
                <div class="oc-empty__title">输入需求后点击执行</div>
              </div>
            </div>
          </div>
        `;
        
        agentInterface.querySelector('.oc-agent-back').addEventListener('click', () => {
          this.activeAgent = null;
          this.update();
        });
        
        agentInterface.querySelector('.oc-agent-clear').addEventListener('click', () => {
          agentInterface.querySelector('.oc-agent-prompt').value = '';
        });
        
        agentInterface.querySelector('.oc-agent-run').addEventListener('click', () => {
          const prompt = agentInterface.querySelector('.oc-agent-prompt').value.trim();
          if (prompt) {
            this.onExecute(this.activeAgent.id, prompt);
          }
        });
        
        layout.appendChild(agentInterface);
      }
      
      el.innerHTML = '';
      el.appendChild(layout);
      
      return el;
    }
    
    setOutput(output) {
      // Update output area with result
      if (this.element) {
        const outputArea = this.element.querySelector('.oc-agent-output');
        if (outputArea) {
          outputArea.innerHTML = `<pre class="oc-agent-result"><code>${this.escapeHtml(output)}</code></pre>`;
        }
      }
    }
    
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  }
};

// Export to global
window.Pages = Pages;
console.log('✅ Page Templates v3.0 loaded');
