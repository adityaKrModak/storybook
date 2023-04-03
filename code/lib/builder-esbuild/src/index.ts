import type { StatsOptions } from 'webpack';
import { logger } from '@storybook/node-logger';
import { dirname, join, parse } from 'path';
import express from 'express';
import fs from 'fs-extra';
import type { Builder } from '@storybook/types';
import type { BuildOptions } from 'esbuild';
import * as esbuild from 'esbuild';

import prettyTime from 'pretty-hrtime';

export * from './types';

export const printDuration = (startTime: [number, number]) =>
  prettyTime(process.hrtime(startTime))
    .replace(' ms', ' milliseconds')
    .replace(' s', ' seconds')
    .replace(' m', ' minutes');

type Stats = any;
type EsbuildBuilder = Builder<BuildOptions, Stats>;
type Unpromise<T extends Promise<any>> = T extends Promise<infer U> ? U : never;

type BuilderStartOptions = Parameters<EsbuildBuilder['start']>['0'];
type BuilderStartResult = Unpromise<ReturnType<EsbuildBuilder['start']>>;
type StarterFunction = (
  options: BuilderStartOptions
) => AsyncGenerator<unknown, BuilderStartResult, void>;

type BuilderBuildOptions = Parameters<EsbuildBuilder['build']>['0'];
type BuilderBuildResult = Unpromise<ReturnType<EsbuildBuilder['build']>>;
type BuilderFunction = (
  options: BuilderBuildOptions
) => AsyncGenerator<Stats | undefined, BuilderBuildResult, void>;

const wrapForPnP = (input: string) => dirname(require.resolve(join(input, 'package.json')));

type TWebpackDevMiddleware = any;

let compilation: ReturnType<TWebpackDevMiddleware> | undefined;
let reject: (reason?: any) => void;

export const getConfig: EsbuildBuilder['getConfig'] = async (options) => {
  const { presets } = options;
  const frameworkOptions = await presets.apply<any>('frameworkOptions');

  return presets.apply(
    'esbuild',
    {},
    {
      ...options,
      frameworkOptions,
    }
  );
};

let asyncIterator: ReturnType<StarterFunction> | ReturnType<BuilderFunction>;

export const bail: EsbuildBuilder['bail'] = async () => {
  if (asyncIterator) {
    try {
      // we tell the builder (that started) to stop ASAP and wait
      await asyncIterator.throw(new Error());
    } catch (e) {
      //
    }
  }

  if (reject) {
    reject();
  }
  // we wait for the compiler to finish it's work, so it's command-line output doesn't interfere
  return new Promise((res, rej) => {
    if (process && compilation) {
      try {
        compilation.close(() => res());
        logger.warn('Force closed preview build');
      } catch (err) {
        logger.warn('Unable to close preview build!');
        res();
      }
    } else {
      res();
    }
  });
};

/**
 * This function is a generator so that we can abort it mid process
 * in case of failure coming from other processes e.g. preview builder
 *
 * I am sorry for making you read about generators today :')
 */
const starter: StarterFunction = async function* starterGeneratorFn({
  startTime,
  options,
  router,
  channel,
}) {
  const config = await getConfig(options);
  yield;
  const compiler = await esbuild.context(config);

  const previewResolvedDir = wrapForPnP('@storybook/preview');

  const { host, port } = await compiler.serve();

  // TODO: Continue
  // Handle publicPath

  const previewDirOrigin = join(previewResolvedDir, 'dist');

  router.use(`/sb-preview`, express.static(previewDirOrigin, { immutable: true, maxAge: '5m' }));

  // TODO: continue here
  router.use(compilation);

  const stats = await new Promise<Stats>((ready, stop) => {
    compilation?.waitUntilValid(ready as any);
    reject = stop;
  });
  yield;

  if (!stats) {
    throw new Error('no stats after building preview');
  }

  if (stats.hasErrors()) {
    throw stats;
  }

  return {
    bail,
    stats,
    totalTime: process.hrtime(startTime),
  };
};

/**
 * This function is a generator so that we can abort it mid process
 * in case of failure coming from other processes e.g. manager builder
 *
 * I am sorry for making you read about generators today :')
 */
const builder: BuilderFunction = async function* builderGeneratorFn({ startTime, options }) {
  const webpackInstance = await executor.get(options);
  yield;
  logger.info('=> Compiling preview..');
  const config = await getConfig(options);
  yield;

  const compiler = webpackInstance(config);

  if (!compiler) {
    const err = `${config.name}: missing webpack compiler at runtime!`;
    logger.error(err);
    return {
      hasErrors: () => true,
      hasWarnings: () => false,
      toJson: () => ({ warnings: [] as any[], errors: [err] }),
    } as any as Stats;
  }

  const webpackCompilation = new Promise<Stats>((succeed, fail) => {
    compiler.run((error, stats) => {
      if (error || !stats || stats.hasErrors()) {
        logger.error('=> Failed to build the preview');
        process.exitCode = 1;

        if (error) {
          logger.error(error.message);

          compiler.close(() => fail(error));

          return;
        }

        if (stats && (stats.hasErrors() || stats.hasWarnings())) {
          const { warnings = [], errors = [] } = stats.toJson(
            typeof config.stats === 'string'
              ? config.stats
              : {
                  warnings: true,
                  errors: true,
                  ...(config.stats as StatsOptions),
                }
          );

          errors.forEach((e) => logger.error(e.message));
          warnings.forEach((e) => logger.error(e.message));

          compiler.close(() =>
            options.debugWebpack
              ? fail(stats)
              : fail(new Error('=> Webpack failed, learn more with --debug-webpack'))
          );

          return;
        }
      }

      logger.trace({ message: '=> Preview built', time: process.hrtime(startTime) });
      if (stats && stats.hasWarnings()) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- we know it has warnings because of hasWarnings()
        stats
          .toJson({ warnings: true } as StatsOptions)
          .warnings!.forEach((e) => logger.warn(e.message));
      }

      // https://webpack.js.org/api/node/#run
      // #15227
      compiler.close((closeErr) => {
        if (closeErr) {
          return fail(closeErr);
        }

        return succeed(stats as Stats);
      });
    });
  });

  const previewResolvedDir = wrapForPnP('@storybook/preview');
  const previewDirOrigin = join(previewResolvedDir, 'dist');
  const previewDirTarget = join(options.outputDir || '', `sb-preview`);

  const previewFiles = fs.copy(previewDirOrigin, previewDirTarget, {
    filter: (src) => {
      const { ext } = parse(src);
      if (ext) {
        return ext === '.mjs';
      }
      return true;
    },
  });

  const [webpackCompilationOutput] = await Promise.all([webpackCompilation, previewFiles]);

  return webpackCompilationOutput;
};

export const start = async (options: BuilderStartOptions) => {
  asyncIterator = starter(options);
  let result;

  do {
    // eslint-disable-next-line no-await-in-loop
    result = await asyncIterator.next();
  } while (!result.done);

  return result.value;
};

export const build = async (options: BuilderStartOptions) => {
  asyncIterator = builder(options);
  let result;

  do {
    // eslint-disable-next-line no-await-in-loop
    result = await asyncIterator.next();
  } while (!result.done);

  return result.value;
};

export const corePresets = [join(__dirname, 'presets/preview-preset.js')];
export const overridePresets = [join(__dirname, './presets/custom-preset.js')];
