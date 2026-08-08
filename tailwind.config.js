/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: {
          base: 'var(--app-base)',
          panel: 'var(--app-panel)',
          panel2: 'var(--app-panel2)',
          border: 'var(--app-border)',
          text: 'var(--app-text)',
          muted: 'var(--app-muted)',
          accent: 'var(--app-accent)',
          accent2: 'var(--app-accent2)',
          danger: 'var(--app-danger)',
          highlight: 'var(--app-highlight)',
        },
      },
      fontFamily: {
        sans: [
          '"Geist"',
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"Geist Mono"', '"Cascadia Code"', '"JetBrains Mono"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
