import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/business/",
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    host: "127.0.0.1",
    port: 4311,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4310",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq, request) => {
            if (request.headers.origin === "http://127.0.0.1:4311") {
              proxyReq.setHeader("Origin", "http://127.0.0.1:4310");
            }
          });
        },
      },
      "/assets": { target: "http://127.0.0.1:4310", changeOrigin: true },
    },
  },
});
