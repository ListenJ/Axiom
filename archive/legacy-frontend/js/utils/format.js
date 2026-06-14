/**
 * OpenClaw Frontend Utils - Format utilities
 */

// Format bytes to human readable
export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

// Format number with commas
export function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Format duration (ms to human readable)
export function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
  return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
}

// Format date
export function formatDate(date, options = {}) {
  const d = new Date(date);
  const now = new Date();
  const diff = now - d;
  
  if (options.relative) {
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' hours ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' days ago';
  }
  
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options
  });
}

// Format time
export function formatTime(date, options = {}) {
  const d = new Date(date);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    ...options
  });
}

// Format datetime
export function formatDateTime(date, options = {}) {
  return formatDate(date, options) + ' ' + formatTime(date, options);
}

// Format price
export function formatPrice(price, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  }).format(price);
}

// Format percentage
export function formatPercent(value, decimals = 1) {
  return (value * 100).toFixed(decimals) + '%';
}

// Truncate text
export function truncate(str, length = 50, suffix = '...') {
  if (!str || str.length <= length) return str;
  return str.slice(0, length) + suffix;
}

// Slugify text
export function slugify(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Capitalize first letter
export function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Camel case to title case
export function camelToTitle(str) {
  return str
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}

// Parse markdown to HTML (simple version)
export function parseMarkdown(text) {
  if (!text) return '';
  
  let html = escapeHtml(text);
  
  // Headers
  html = html.replace(/^#{1,6} (.+)$/gm, (match, content) => {
    const level = match.match(/^#+/)[0].length;
    return `<h${level}>${content}</h${level}>`;
  });
  
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  
  // Code inline
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Code blocks
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang || 'text'}">${escapeHtml(code.trim())}</code></pre>`;
  });
  
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  
  // Lists
  html = html.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/<ul>(\s*<li)/, '$1');
  html = html.replace(/(<\/li>)\s*<\/ul>\s*<ul>/g, '$1');
  
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Highlight code (basic)
export function highlightCode(code, language) {
  // Simple syntax highlighting
  let highlighted = escapeHtml(code);
  
  // Keywords
  const keywords = /\b(function|const|let|var|if|else|for|while|return|class|import|export|async|await|try|catch|throw|new|this|typeof|instanceof|undefined|null|true|false)\b/g;
  highlighted = highlighted.replace(keywords, '<span class="keyword">$1</span>');
  
  // Strings
  highlighted = highlighted.replace(/("[^"]*")/g, '<span class="string">$1</span>');
  highlighted = highlighted.replace(/('[^']*')/g, '<span class="string">$1</span>');
  highlighted = highlighted.replace(/(`[^`]*`)/g, '<span class="string">$1</span>');
  
  // Comments
  highlighted = highlighted.replace(/(\/\/.*$)/gm, '<span class="comment">$1</span>');
  highlighted = highlighted.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="comment">$1</span>');
  
  // Numbers
  highlighted = highlighted.replace(/\b(\d+\.?\d*)\b/g, '<span class="number">$1</span>');
  
  return highlighted;
}

// Generate unique ID
export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Deep clone
export function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj);
  if (obj instanceof Array) return obj.map(item => deepClone(item));
  if (obj instanceof Object) {
    const cloned = {};
    Object.keys(obj).forEach(key => {
      cloned[key] = deepClone(obj[key]);
    });
    return cloned;
  }
  return obj;
}

// Deep merge
export function deepMerge(target, source) {
  if (!source) return target;
  if (!target) return deepClone(source);
  
  Object.keys(source).forEach(key => {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      target[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  });
  
  return target;
}

// Debounce
export function debounce(fn, delay = 300) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Throttle
export function throttle(fn, limit = 100) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}
