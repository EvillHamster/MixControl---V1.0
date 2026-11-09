import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3001}`,
        changeOrigin: false,
      },
    },
  },
});
