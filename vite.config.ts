import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    css: {
      // Declaring PostCSS inline stops Vite hunting for a postcss.config.* file,
      // which it otherwise does by walking up the filesystem. Unzip this project
      // underneath a folder that happens to contain its own PostCSS config and
      // node_modules — a Downloads folder with another project in it will do —
      // and that stranger's config wins, dragging in its Tailwind. A v3 Tailwind
      // then meets this project's v4 stylesheet and dies on
      // "`@layer base` is used but no matching `@tailwind base` directive".
      //
      // Tailwind v4 runs through the @tailwindcss/vite plugin above, so there is
      // genuinely nothing for PostCSS to do here. An empty plugin list is the
      // honest answer and makes the project immune to where it is unzipped.
      postcss: { plugins: [] },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
