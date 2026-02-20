import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // All API calls forwarded to FastAPI backend — eliminates CORS in development
      '/rag-chat': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/add-doc': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/upload-pdf': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
