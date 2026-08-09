import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import 'katex/dist/katex.min.css';

// 捕获未处理异常，便于定位启动期问题（正式版不依赖此日志）
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason instanceof Error ? e.reason.stack ?? e.reason.message : e.reason);
});
window.addEventListener('error', (e) => {
  console.error('[window.error]', e.error instanceof Error ? e.error.stack ?? e.error.message : e.message);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
