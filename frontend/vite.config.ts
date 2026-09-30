import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api/ws": { target: "ws://127.0.0.1:8710", ws: true },
      "/api": "http://127.0.0.1:8710",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
