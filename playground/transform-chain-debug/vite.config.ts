import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      name: 'debug:user-transform',
      transform(code, id) {
        if (id.includes('/src/')) {
          console.log('[debug:user-transform]', id, code.length)
        }
        return null
      },
    },
  ],
})
