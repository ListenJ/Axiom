# OpenClaw Frontend Architecture v3.0

## 架构目标
- 模块化：组件化设计，代码复用
- 可维护：清晰的分层和数据流
- 可扩展：支持新页面和功能的无缝添加
- 性能：按需加载，智能缓存

## 目录结构

```
public/
├── index.html              # 入口 HTML
├── app.js                  # 入口 JS (精简版)
├── css/
│   ├── base.css           # 基础样式
│   ├── components.css     # 组件样式
│   └── pages.css          # 页面样式
├── js/
│   ├── core/
│   │   ├── router.js      # 路由系统
│   │   ├── state.js       # 状态管理
│   │   ├── api.js         # API 封装
│   │   └── events.js      # 事件总线
│   ├── components/
│   │   ├── Button.js      # 按钮组件
│   │   ├── Card.js        # 卡片组件
│   │   ├── Modal.js       # 弹窗组件
│   │   ├── Toast.js       # 提示组件
│   │   ├── CodeBlock.js   # 代码块组件
│   │   └── Chart.js       # 图表组件
│   ├── pages/
│   │   ├── ChatPage.js    # 聊天页面
│   │   ├── SearchPage.js  # 搜索页面
│   │   ├── CodePage.js    # 代码页面
│   │   ├── AgentsPage.js  # Agent 页面
│   │   ├── RouterPage.js  # 路由页面
│   │   ├── VaultPage.js   # Vault 页面
│   │   ├── PerfPage.js    # 性能页面
│   │   └── SettingsPage.js # 设置页面
│   └── utils/
│       ├── dom.js         # DOM 工具
│       ├── format.js      # 格式化
│       └── cache.js       # 缓存
└── plugins/               # 插件目录

```

## 核心设计

### 1. 路由系统 (Router)
```javascript
// 声明式路由配置
const routes = {
  '/chat': { component: ChatPage, title: 'Chat', preload: true },
  '/search': { component: SearchPage, title: 'Search' },
  '/code': { component: CodePage, title: 'Code', onEnter: fetchCodeData },
  '/agents/:id': { component: AgentsPage, title: 'Agents', lazy: true },
  // ...
};
```

### 2. 状态管理 (State)
```javascript
// 响应式状态
const store = createStore({
  user: null,
  theme: 'dark',
  notifications: [],
  router: { current: '/', params: {} }
});

// 订阅状态变化
store.subscribe('theme', (newTheme, oldTheme) => {
  applyTheme(newTheme);
});
```

### 3. 组件系统 (Components)
```javascript
// 声明式组件
class ChatMessage extends Component {
  template({ message, isUser }) {
    return `
      <div class="message ${isUser ? 'user' : 'ai'}">
        <div class="content">${renderMarkdown(message)}</div>
        ${!isUser ? actionsTemplate() : ''}
      </div>
    `;
  }
  
  events() {
    return {
      'click .copy-btn': this.handleCopy,
      'click .regenerate-btn': this.handleRegenerate
    };
  }
}
```

### 4. API 层 (API)
```javascript
// API 封装
const api = {
  chat: {
    send: (message, options) => post('/chat', { message, ...options }),
    stream: (message, onChunk) => stream('/chat', { message }, onChunk)
  },
  codegraph: {
    search: (query) => get('/codegraph/search', { q: query }),
    status: () => get('/codegraph/status')
  },
  // ...
};

// 自动错误处理和重试
api.interceptors.response.use(
  res => res,
  err => {
    if (err.status === 401) navigate('/login');
    return Promise.reject(err);
  }
);
```

## 迁移策略

### Phase 1: 核心基础设施
1. 创建 `js/core/` 目录和基础文件
2. 实现路由系统
3. 实现状态管理
4. 实现 API 封装

### Phase 2: 组件库
1. 创建常用 UI 组件
2. 将现有 HTML/CSS 提取为组件
3. 建立组件文档

### Phase 3: 页面迁移
1. 逐个迁移页面到新的页面组件
2. 保持现有功能不变
3. 添加新的架构特性 (懒加载、预加载等)

### Phase 4: 优化和清理
1. 删除旧代码
2. 性能优化
3. 代码分割和按需加载

## 兼容性

- 保持现有 API 端点不变
- 渐进式迁移，不破坏现有功能
- 保留快捷键和交互习惯
