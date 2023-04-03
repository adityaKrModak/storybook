import type { Options } from '@storybook/types';
import type { BuildOptions } from 'esbuild';
import RawPlugin from 'esbuild-plugin-raw';

const externalAssetExtensions = [
  'svg',
  'ico',
  'jpg',
  'jpeg',
  'png',
  'apng',
  'gif',
  'eot',
  'otf',
  'webp',
  'ttf',
  'woff',
  'woff2',
  'cur',
  'ani',
  'pdf',
  'mp4',
  'webm',
  'wav',
  'mp3',
  'm4a',
  'aac',
  'oga',
];

export async function createDefaultEsbuildConfig(
  storybookBaseConfig: BuildOptions,
  options: Options
): Promise<BuildOptions> {
  const isProd = options.configType === 'PRODUCTION';

  return {
    ...storybookBaseConfig,
    assetNames: isProd ? 'static/media/[name][hash]' : 'static/media/[dir][name][ext]',
    plugins: [...(storybookBaseConfig.plugins ?? []), RawPlugin()],
    loader: {
      ...storybookBaseConfig.loader,
      ...externalAssetExtensions.reduce((acc, ext) => {
        acc[`.${ext}`] = 'file';
        return acc;
      }, {} as Record<string, 'file'>),
    },
  };
}
