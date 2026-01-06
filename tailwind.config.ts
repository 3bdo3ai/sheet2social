import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        'cairo': ['Cairo', 'sans-serif'],
        'tajawal': ['Tajawal', 'sans-serif'],
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          50: '#f8f9fa',
          100: '#e9ecef',
          200: '#dee2e6',
          300: '#ced4da',
          400: '#adb5bd',
          500: '#6c757d',
          600: '#495057',
          700: '#343a40',
          800: '#212529',
          900: '#000000',
          DEFAULT: '#343a40',
        },
        secondary: {
          50: '#f1f3f8',
          100: '#dde2ed',
          500: '#14213d',
          600: '#14213d',
          700: '#0f1a30',
          800: '#0c1526',
          900: '#09101c',
          DEFAULT: '#14213d',
        },
        accent: {
          50: '#fef9e7',
          100: '#fef0c7',
          200: '#fed288',
          300: '#fcb849',
          400: '#fca311',
          500: '#fca311',
          600: '#dc8a0e',
          700: '#b8700b',
          800: '#945608',
          900: '#7a4506',
          DEFAULT: '#fca311',
        },
        light: {
          50: '#fefefe',
          100: '#fdfdfd',
          200: '#f8f9fa',
          300: '#f1f3f4',
          400: '#e8eaed',
          500: '#dadce0',
          600: '#bdc1c6',
          700: '#9aa0a6',
          800: '#5f6368',
          900: '#3c4043',
          DEFAULT: '#f8f9fa',
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.6s ease-in-out',
        'slide-up': 'slideUp 0.8s ease-out',
        'slide-in-left': 'slideInLeft 0.8s ease-out',
        'slide-in-right': 'slideInRight 0.8s ease-out',
        'bounce-slow': 'bounce 2s infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'float': 'float 6s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(30px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideInLeft: {
          '0%': { transform: 'translateX(-30px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(30px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
      },
    },
  },
  plugins: [
    require('tailwindcss-rtl')
  ],
};

export default config;