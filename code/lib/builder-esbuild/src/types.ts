import type { BuildOptions } from 'esbuild';

export interface StorybookConfigEsbuild {
  /**
   * Modify or return a custom Webpack config after the Storybook's default configuration
   * has run (mostly used by addons).
   */
  esbuild?: (options: BuildOptions) => BuildOptions | Promise<BuildOptions>;

  /**
   * Modify or return a custom Webpack config after every addon has run.
   */
  esbuildFinal?: (options: BuildOptions) => BuildOptions | Promise<BuildOptions>;
}
