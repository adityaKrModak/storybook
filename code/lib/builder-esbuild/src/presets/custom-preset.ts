import { logger } from '@storybook/node-logger';
import type { Options } from '@storybook/types';
import type { BuildOptions } from 'esbuild';
import { createDefaultEsbuildConfig } from '../preview/base.config';

export async function esbuild(config: BuildOptions, options: Options) {
  logger.info('=> Using default esbuild setup');
  const defaultConfig = await createDefaultEsbuildConfig(config, options);
  return options.presets.apply('esbuildFinal', defaultConfig, options);
}
