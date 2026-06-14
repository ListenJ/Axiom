/**
 * OpenClaw Frontend Utils - DOM utilities
 */

// Create element with attributes and children
export function createElement(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  
  Object.entries(attrs).forEach(([key, val]) => {
    if (key === 'className') {
      el.className = val;
    } else if (key === 'style' && typeof val === 'object') {
      Object.assign(el.style, val);
    } else if (key.startsWith('on') && typeof val === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else {
      el.setAttribute(key, val);
    }
  });
  
  children.forEach(child => {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else if (child) {
      el.appendChild(document.createTextNode(String(child)));
    }
  });
  
  return el;
}

// Query elements with caching
const queryCache = new Map();
export function $(selector, context = document) {
  const key = selector + (context === document ? '' : context.id || context.className);
  if (queryCache.has(key)) {
    return queryCache.get(key);
  }
  const el = context.querySelector(selector);
  queryCache.set(key, el);
  return el;
}

export function $$(selector, context = document) {
  return Array.from(context.querySelectorAll(selector));
}

// Clear query cache
export function clearQueryCache() {
  queryCache.clear();
}

// Wait for element to appear in DOM
export function waitFor(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
    
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${selector}`));
    }, timeout);
  });
}

// Debounce function
export function debounce(fn, delay = 300) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Throttle function
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

// Animate element
export function animate(el, keyframes, options = {}) {
  return el.animate(keyframes, {
    duration: options.duration || 300,
    easing: options.easing || 'ease',
    fill: options.fill || 'forwards',
    ...options
  });
}

// Fade in element
export function fadeIn(el, duration = 300) {
  el.style.opacity = '0';
  el.style.display = 'block';
  return animate(el, [
    { opacity: 0 },
    { opacity: 1 }
  ], { duration });
}

// Fade out element
export function fadeOut(el, duration = 300) {
  return animate(el, [
    { opacity: 1 },
    { opacity: 0 }
  ], { duration }).finished.then(() => {
    el.style.display = 'none';
  });
}

// Scroll to element
export function scrollTo(el, options = {}) {
  const { offset = 0, behavior = 'smooth' } = options;
  const top = el.getBoundingClientRect().top + window.scrollY + offset;
  window.scrollTo({ top, behavior });
}

// Copy to clipboard
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  }
}

// Escape HTML
export function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Safe set innerHTML
export function setHtml(el, html) {
  el.innerHTML = html;
  // Execute scripts if any
  el.querySelectorAll('script').forEach(script => {
    const newScript = document.createElement('script');
    newScript.textContent = script.textContent;
    document.head.appendChild(newScript);
    document.head.removeChild(newScript);
  });
}

// Measure element
export function measure(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return {
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    margin: {
      top: parseFloat(style.marginTop),
      right: parseFloat(style.marginRight),
      bottom: parseFloat(style.marginBottom),
      left: parseFloat(style.marginLeft)
    },
    padding: {
      top: parseFloat(style.paddingTop),
      right: parseFloat(style.paddingRight),
      bottom: parseFloat(style.paddingBottom),
      left: parseFloat(style.paddingLeft)
    }
  };
}

// Intersection observer helper
export function observeIntersection(el, callback, options = {}) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      callback(entry.isIntersecting, entry);
    });
  }, options);
  
  observer.observe(el);
  
  return () => observer.disconnect();
}

// Resize observer helper
export function observeResize(el, callback) {
  const observer = new ResizeObserver((entries) => {
    callback(entries[0].contentRect);
  });
  
  observer.observe(el);
  
  return () => observer.disconnect();
}
