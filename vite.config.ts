/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发模式下 Vite 不清屏，端口固定
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 忽略 Rust 构建目录：exe 编译时被锁，会导致 Vite watcher 崩溃
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome105",
    outDir: "dist",
  },
  test: {
    // 纯逻辑单测（store / util / api 归一化），无需 DOM 环境
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
