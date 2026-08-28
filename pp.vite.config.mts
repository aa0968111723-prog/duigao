import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "perfprobe",
  base: "./",
  plugins: [react()],
  build: { outDir: "../pp-dist", emptyOutDir: true, minify: "esbuild" },
});
