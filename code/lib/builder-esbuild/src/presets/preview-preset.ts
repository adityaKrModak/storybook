import esbuildConfig from '../preview/iframe.config';

export const esbuild = async (_: unknown, options: any) => esbuildConfig(options);

export const previewMainTemplate = () =>
  require.resolve('@storybook/builder-esbuild/templates/preview.ejs');
