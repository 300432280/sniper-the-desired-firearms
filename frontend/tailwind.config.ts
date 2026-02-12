import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        background: '#0D0D0D',
        surface: {
          DEFAULT: '#111111',
          elevated: '#161616',
        },
        border: {
          DEFAULT: '#1E1E1E',
          strong: '#2A2A2A',
        },
        foreground: {
          DEFAULT: '#E2E2E2',
          muted: '#6B7280',
          dim: '#3D3D3D',
        },
        accent: {
          DEFAULT: '#4D7A3C',
          hover: '#5D9448',
          light: '#6BAF53',
          subtle: '#1A2E18',
        },
        secondary: {
          DEFAULT: '#D4620A',
          hover: '#E8751F',
          subtle: '#2D1A05',
        },
        danger: {
          DEFAULT: '#B91C1C',
          subtle: '#2D0F0F',
        },
      },
      fontFamily: {
        heading: ['Rajdhani', 'Impact', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      backgroundImage: {
        'grid-texture':
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Cpath d='M0 0h40v40H0z' fill='none'/%3E%3Cpath d='M0 0v40M40 0v40M0 0h40M0 40h40' stroke='%231E1E1E' stroke-width='0.5'/%3E%3C/svg%3E\")",
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
        'fade-in': 'fade-in 0.3s ease-out forwards',
      },
    },
  },
  plugins: [],
};

export default config;
