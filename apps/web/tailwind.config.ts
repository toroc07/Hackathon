import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        dispatch: {
          ink: '#15211d',
          canvas: '#f4f5f1',
          red: '#b4232c',
          green: '#23634d',
        },
      },
    },
  },
  plugins: [],
};

export default config;
