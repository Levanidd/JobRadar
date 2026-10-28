import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Two pages share one bundle graph: the current admin at `/` and the
    // redesign at `/v2/`. Both talk to the same `/api`, so either can be used
    // while the other is still there.
    rollupOptions: {
      input: {
        main: "index.html",
        v2: "v2/index.html",
      },
    },
  },
  server: {
    // shared/ sits next to the admin, one level up, and is imported by both sides.
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:43142",
    },
  },
})
