import { dirname, join, resolve } from 'path';
import { esbuildTsChecker } from 'esbuild-plugin-ts-checker';
import slash from 'slash';
import type { BuildOptions } from 'esbuild';
import type { Options, CoreConfig, DocsOptions, PreviewAnnotation } from '@storybook/types';
import { globals } from '@storybook/preview/globals';
import {
  stringifyProcessEnvs,
  handlebars,
  normalizeStories,
  readTemplate,
  loadPreviewOrConfigFile,
  isPreservingSymlinks,
} from '@storybook/core-common';
import { toImportFn } from '@storybook/core-webpack';
import { dedent } from 'ts-dedent';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import { htmlPlugin } from '@craftamap/esbuild-plugin-html';
import { globalExternals } from '@fal-works/esbuild-plugin-global-externals';
import { virtualModulePlugin } from './plugins/virtual-module-plugin';

const wrapForPnP = (input: string) => dirname(require.resolve(join(input, 'package.json')));

const storybookPaths: Record<string, string> = {
  global: wrapForPnP('@storybook/global'),
  ...[
    // these packages are not pre-bundled because of react dependencies
    'api',
    'components',
    'global',
    'manager-api',
    'router',
    'theming',
  ].reduce(
    (acc, sbPackage) => ({
      ...acc,
      [`@storybook/${sbPackage}`]: wrapForPnP(`@storybook/${sbPackage}`),
    }),
    {}
  ),
  // deprecated, remove in 8.0
  [`@storybook/api`]: wrapForPnP(`@storybook/manager-api`),
};

export default async (options: Options & Record<string, any>): Promise<BuildOptions> => {
  const {
    outputDir = join('.', 'public'),
    packageJson,
    configType,
    presets,
    previewUrl,
    features,
    serverChannelUrl,
  } = options;

  const isProd = configType === 'PRODUCTION';
  const workingDir = process.cwd();

  const [
    coreOptions,
    frameworkOptions,
    envs,
    logLevel,
    headHtmlSnippet,
    bodyHtmlSnippet,
    template,
    docsOptions,
    entries,
    nonNormalizedStories,
  ] = await Promise.all([
    presets.apply<CoreConfig>('core'),
    presets.apply('frameworkOptions'),
    presets.apply<Record<string, string>>('env'),
    presets.apply('logLevel', undefined),
    presets.apply('previewHead'),
    presets.apply('previewBody'),
    presets.apply<string>('previewMainTemplate'),
    presets.apply<DocsOptions>('docs'),
    presets.apply<string[]>('entries', []),
    presets.apply('stories', []),
  ]);

  const stories = normalizeStories(nonNormalizedStories, {
    configDir: options.configDir,
    workingDir,
  });

  const previewAnnotations = [
    ...(await presets.apply<PreviewAnnotation[]>('previewAnnotations', [], options)).map(
      (entry) => {
        // If entry is an object, use the absolute import specifier.
        // This is to maintain back-compat with community addons that bundle other addons
        // and package managers that "hide" sub dependencies (e.g. pnpm / yarn pnp)
        // The vite builder uses the bare import specifier.
        if (typeof entry === 'object') {
          return entry.absolute;
        }

        return slash(entry);
      }
    ),
    loadPreviewOrConfigFile(options),
  ].filter(Boolean);

  const virtualModuleMapping: Record<string, string> = {};

  if (features?.storyStoreV7) {
    const storiesFilename = 'storybook-stories.js';
    const storiesPath = resolve(join(workingDir, storiesFilename));

    virtualModuleMapping[storiesPath] = toImportFn(stories, { needPipelinedImport: false });
    const configEntryPath = resolve(join(workingDir, 'storybook-config-entry.js'));
    virtualModuleMapping[configEntryPath] = handlebars(
      await readTemplate(
        require.resolve(
          '@storybook/builder-esbuild/templates/virtualModuleModernEntry.js.handlebars'
        )
      ),
      {
        storiesFilename,
        previewAnnotations,
      }
      // We need to double escape `\` for webpack. We may have some in windows paths
    ).replace(/\\/g, '\\\\');
    entries.push(configEntryPath);
  } else {
    throw new Error(
      "Storybook's esbuild builder does not support disabled StoryStoreV7. Please use the webpack5 or vite builder instead."
    );
  }

  if (!template) {
    throw new Error(dedent`
      Storybook's esbuild builder requires a template to be specified.
      Somehow you've ended up with a falsy value for the template option.

      Please file an issue at https://github.com/storybookjs/storybook with a reproduction.
    `);
  }

  // TODO: Implement watch and serve mode somewhere else :D

  return {
    target: 'es6',
    entryPoints: entries,
    // TODO: Try to set to false
    keepNames: true,
    // TODO: Does it make some trouble? Mangle options?
    minify: isProd,
    // TODO: Is isProd the right value here?
    bundle: isProd,
    splitting: true,
    format: 'esm',
    outdir: resolve(process.cwd(), outputDir),
    // TODO: Is this correct?!
    preserveSymlinks: !isPreservingSymlinks(),
    // TODO: Are path, asset and util polyfilled?
    plugins: [
      virtualModulePlugin({
        virtualModuleMap: virtualModuleMapping,
      }),
      htmlPlugin({
        files: [
          {
            filename: 'iframe.html',
            htmlTemplate: template,
            entryPoints: entries,
            define: {
              version: packageJson.version ?? 'undefined',
              globals: JSON.stringify({
                CONFIG_TYPE: configType,
                LOGLEVEL: logLevel,
                FRAMEWORK_OPTIONS: frameworkOptions,
                CHANNEL_OPTIONS: coreOptions.channelOptions,
                FEATURES: features,
                PREVIEW_URL: previewUrl,
                STORIES: stories.map((specifier) => ({
                  ...specifier,
                  importPathMatcher: specifier.importPathMatcher.source,
                })),
                DOCS_OPTIONS: docsOptions,
                SERVER_CHANNEL_URL: serverChannelUrl,
              }),
              headHtmlSnippet: (headHtmlSnippet ?? 'undefined') as string,
              bodyHtmlSnippet: (bodyHtmlSnippet ?? 'undefined') as string,
            },
          },
        ],
      }),
      globalExternals(globals),
      esbuildTsChecker(),
      NodeModulesPolyfillPlugin(),
      NodeGlobalsPolyfillPlugin({
        process: true,
      }),
    ],
    resolveExtensions: ['.mjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.cjs'],
    alias: storybookPaths,
    mainFields: ['browser', 'module', 'main'],
    nodePaths: [envs.NODE_PATH],
    loader: {
      '.md': 'copy',
    },
    define: {
      ...stringifyProcessEnvs(envs),
      NODE_ENV: JSON.stringify(process.env.NODE_ENV),
    },
    sourcemap: true,
    assetNames: isProd ? '[name].[hash].iframe.bundle.js' : '[name].iframe.bundle.js',
    // TODO: publicPath needed?
    // publicPath: ''
    logLevel: 'error',
    // required by html plugin
    metafile: true,
  };
};
