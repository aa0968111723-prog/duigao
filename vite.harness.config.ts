/**
 * 提案面板驗收 harness 的獨立打包設定（PR-DI-04）。
 *
 * **刻意不動共用的 `vite.config.ts`** —— 那個檔案別條工作線也在用，
 * 為了跑一個驗收去改它的 rollupOptions 是不必要的耦合。
 *
 * 只有 `npm run test:proposal-ui` 會用到這份設定，正式 build 完全不受影響。
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-harness",
    emptyOutDir: true,
    rollupOptions: { input: "design-intelligence-harness.html" },
  },
});
