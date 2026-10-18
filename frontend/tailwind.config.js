/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['Poppins', 'sans-serif'],
        display: ['Poppins', 'sans-serif'],
        mono:    ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        brand: {
          50:  '#F4F1FF',
          100: '#EDE8FF',
          200: '#DDD6FE',
          300: '#C4B5FD',
          400: '#A78BFA',
          500: '#8B7CFF',
          600: '#6D5EF7',
          700: '#5B4BE0',
          800: '#4C3BBF',
          900: '#3D2F9E',
        },
      },
      borderRadius: {
        DEFAULT: '8px',
        'lg':  '12px',
        'xl':  '14px',
        '2xl': '18px',
        '3xl': '24px',
      },
      boxShadow: {
        card:         '0 1px 3px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 16px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.04)',
        navbar:       '0 1px 3px rgba(0,0,0,0.06)',
        btn:          '0 4px 12px rgba(109,94,247,0.30)',
        dropdown:     '0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
      },
      animation: {
        'fade-in': 'fadeInUp 0.3s ease both',
        shimmer:   'shimmer 1.4s infinite',
      },
      keyframes: {
        fadeInUp: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
}
