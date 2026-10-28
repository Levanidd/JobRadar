import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // shared/ sits next to the admin, one level up, and is imported by both sides.
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:43142",
    },
  },
})
