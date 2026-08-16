import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import type * as net from 'node:net'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import type * as http from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Http2SecureServer } from 'node:http2'
import connect from 'connect'
import corsMiddleware from 'cors'
import colors from 'picocolors'
import chokidar from 'chokidar'
import launchEditorMiddleware from 'launch-editor-middleware'
import { determineAgent } from '@vercel/detect-agent'
import { disableCache } from '@voidzero-dev/vite-task-client'
import type { SourceMap } from 'rolldown'
import type { ModuleRunner } from 'vite/module-runner'
import type { FSWatcher, WatchOptions } from '#dep-types/chokidar'
import type { Connect } from '#dep-types/connect'
import type { CommonServerOptions } from '../http'
import type {
  ForwardConsoleOptions,
  ResolvedForwardConsoleOptions,
} from '../../shared/forwardConsole'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from '../http'
import type { InlineConfig, ResolvedConfig } from '../config'
import { isResolvedConfig, resolveConfig } from '../config'
import {
  type Hostname,
  diffDnsOrderChange,
  getServerUrlByHost,
  isInNodeModules,
  isObject,
  isParentDirectory,
  mergeConfig,
  mergeWithDefaults,
  monotonicDateNow,
  normalizePath,
  resolveHostname,
  resolveServerUrls,
  setupHmrWsOptionCompat,
  setupSIGTERMListener,
  teardownSIGTERMListener,
} from '../utils'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { ssrFixStacktrace, ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import { reloadOnTsconfigChange } from '../plugins/esbuild'
import { bindCLIShortcuts } from '../shortcuts'
import type { BindCLIShortcutsOptions, ShortcutsState } from '../shortcuts'
import {
  CLIENT_DIR,
  DEFAULT_DEV_PORT,
  defaultAllowedOrigins,
} from '../constants'
import type { Logger } from '../logger'
import { printServerUrls } from '../logger'
import { warnFutureDeprecation } from '../deprecations'
import {
  createNoopWatcher,
  getResolvedOutDirs,
  resolveChokidarOptions,
  resolveEmptyOutDir,
} from '../watch'
import { initPublicFiles } from '../publicDir'
import { getEnvFilesForMode } from '../env'
import type { RequiredExceptFor } from '../typeUtils'
import type { MinimalPluginContextWithoutEnvironment } from '../plugin'
import type { PluginContainer } from './pluginContainer'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
  createPluginContainer,
} from './pluginContainer'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware } from './middlewares/proxy'
import { htmlFallbackMiddleware } from './middlewares/htmlFallback'
import {
  cachedTransformMiddleware,
  transformMiddleware,
} from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware,
} from './middlewares/indexHtml'
import {
  servePublicMiddleware,
  serveRawFsMiddleware,
  serveStaticMiddleware,
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import { ModuleGraph } from './mixedModuleGraph'
import type { ModuleNode } from './mixedModuleGraph'
import { notFoundMiddleware } from './middlewares/notFound'
import { errorMiddleware } from './middlewares/error'
import type { HmrOptions, NormalizedHotChannel, WsOptions } from './hmr'
import { handleHMRUpdate, updateModules } from './hmr'
import { openBrowser as _openBrowser } from './openBrowser'
import type { TransformOptions, TransformResult } from './transformRequest'
import { searchForPackageRoot, searchForWorkspaceRoot } from './searchRoot'
import type { DevEnvironment } from './environment'
import { hostValidationMiddleware } from './middlewares/hostCheck'
import { rejectInvalidRequestMiddleware } from './middlewares/rejectInvalidRequest'
import { memoryFilesMiddleware } from './middlewares/memoryFiles'
import { triggerLazyBundlingMiddleware } from './middlewares/triggerLazyBundling'

const usedConfigs = new WeakSet<ResolvedConfig>()

export interface ServerOptions extends CommonServerOptions {
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * Configure WebSocket connection options.
   * Set to `false` to disable the WebSocket server and connection.
   */
  ws?: WsOptions | false
  /**
   * Warm-up files to transform and cache the results in advance. This improves the
   * initial page load during server starts and prevents transform waterfalls.
   */
  warmup?: {
    /**
     * The files to be transformed and used on the client-side. Supports glob patterns.
     */
    clientFiles?: string[]
    /**
     * The files to be transformed and used in SSR. Supports glob patterns.
     */
    ssrFiles?: string[]
  }
  /**
   * chokidar watch options or null to disable FS watching
   * https://github.com/paulmillr/chokidar/tree/3.6.0#api
   */
  watch?: WatchOptions | null
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   * @default false
   */
  middlewareMode?:
    | boolean
    | {
        /**
         * Parent server instance to attach to
         *
         * This is needed to proxy WebSocket connections to the parent server.
         */
        server: HttpServer
      }
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   *
   * @example `http://127.0.0.1:8080`
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   * @default true
   */
  preTransformRequests?: boolean
  /**
   * Whether or not to ignore-list source files in the dev server sourcemap, used to populate
   * the [`x_google_ignoreList` source map extension](https://developer.chrome.com/blog/devtools-better-angular-debugging/#the-x_google_ignorelist-source-map-extension).
   *
   * By default, it excludes all paths containing `node_modules`. You can pass `false` to
   * disable this behavior, or, for full control, a function that takes the source path and
   * sourcemap path and returns whether to ignore the source path.
   */
  sourcemapIgnoreList?:
    | false
    | ((sourcePath: string, sourcemapPath: string) => boolean)
  /**
   * Backward compatibility. The buildStart and buildEnd hooks were called only once for
   * the client environment. This option enables per-environment buildStart and buildEnd hooks.
   * @default false
   * @experimental
   */
  perEnvironmentStartEndDuringDev?: boolean
  /**
   * Backward compatibility. The watchChange hook was called only once for the client environment.
   * This option enables per-environment watchChange hooks.
   * @default false
   * @experimental
   */
  perEnvironmentWatchChangeDuringDev?: boolean
  /**
   * Run HMR tasks, by default the HMR propagation is done in parallel for all environments
   * @experimental
   */
  hotUpdateEnvironments?: (
    server: ViteDevServer,
    hmr: (environment: DevEnvironment) => Promise<void>,
  ) => Promise<void>

  forwardConsole?: boolean | ForwardConsoleOptions
}

export interface ResolvedServerOptions extends Omit<
  RequiredExceptFor<
    ServerOptions,
    | 'host'
    | 'https'
    | 'proxy'
    | 'hmr'
    | 'ws'
    | 'watch'
    | 'origin'
    | 'hotUpdateEnvironments'
  >,
  'fs' | 'middlewareMode' | 'sourcemapIgnoreList' | 'forwardConsole'
> {
  fs: Required<FileSystemServeOptions>
  middlewareMode: NonNullable<ServerOptions['middlewareMode']>
  sourcemapIgnoreList: Exclude<
    ServerOptions['sourcemapIgnoreList'],
    false | undefined
  >
  forwardConsole: ResolvedForwardConsoleOptions
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * picomatch patterns are supported.
   *
   * @default ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**\/.git/**']
   */
  deny?: string[]
}

export type ServerHook = (
  this: MinimalPluginContextWithoutEnvironment,
  server: ViteDevServer,
) => (() => void) | void | Promise<(() => void) | void>

export type HttpServer = http.Server | Http2SecureServer

export async function resolveForwardConsoleOptions(
  value: boolean | ForwardConsoleOptions | undefined,
): Promise<ResolvedForwardConsoleOptions> {
  value ??= (await determineAgent()).isAgent

  if (value === false) {
    return {
      enabled: false,
      unhandledErrors: false,
      logLevels: [],
    }
  }

  if (value === true) {
    return {
      enabled: true,
      unhandledErrors: true,
      logLevels: ['error', 'warn'],
    }
  }

  const unhandledErrors = value.unhandledErrors ?? true
  const logLevels = value.logLevels ?? []

  return {
    enabled: unhandledErrors || logLevels.length > 0,
    unhandledErrors,
    logLevels,
  }
}

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: HttpServer | null
  /**
   * Chokidar watcher instance. If `config.server.watch` is set to `null`,
   * it will not watch any files and calling `add` or `unwatch` will have no effect.
   * https://github.com/paulmillr/chokidar/tree/3.6.0#api
   */
  watcher: FSWatcher
  /**
   * WebSocket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * An alias to `server.environments.client.hot`.
   * If you want to interact with all environments, loop over `server.environments`.
   */
  hot: NormalizedHotChannel
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module execution environments attached to the Vite server.
   */
  environments: Record<'client' | 'ssr' | (string & {}), DevEnvironment>
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * The resolved urls Vite prints on the CLI (URL-encoded). Returns `null`
   * in middleware mode or if the server is not listening on any port.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions,
  ): Promise<TransformResult | null>
  /**
   * Same as `transformRequest` but only warm up the URLs so the next request
   * will already be cached. The function will never throw as it handles and
   * reports errors internally.
   */
  warmupRequest(url: string, options?: TransformOptions): Promise<void>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string>
  /**
   * Transform module code into SSR format.
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | { mappings: '' } | null,
    url: string,
    originalCode?: string,
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean },
  ): Promise<Record<string, any>>
  /**
   * Returns a fixed version of the given stack
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Triggers HMR for a module in the module graph. You can use the `server.moduleGraph`
   * API to retrieve the module to be reloaded. If `hmr` is false, this is a no-op.
   */
  reloadModule(module: ModuleNode): Promise<void>
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<ViteDevServer>): void
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>
  /**
   * Open browser
   */
  openBrowser(): void
  /**
   * Calling `await server.waitForRequestsIdle(id)` will wait until all static imports
   * are processed. If called from a load or transform plugin hook, the id needs to be
   * passed as a parameter to avoid deadlocks. Calling this function after the first
   * static imports section of the module graph has been processed will resolve immediately.
   */
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  /**
   * @internal
   */
  _setInternalServer(server: ViteDevServer): void
  /**
   * @internal
   */
  _restartPromise: Promise<void> | null
  /**
   * @internal
   */
  _forceOptimizeOnRestart: boolean
  /**
   * @internal
   */
  _shortcutsState?: ShortcutsState<ViteDevServer>
  /**
   * @internal
   */
  _currentServerPort?: number | undefined
  /**
   * @internal
   */
  _configServerPort?: number | undefined
  /**
   * @internal
   */
  _ssrCompatModuleRunner?: ModuleRunner
}

export interface ResolvedServerUrls {
  local: string[]
  network: string[]
}

export function createServer(
  inlineConfig: InlineConfig | ResolvedConfig = {},
): Promise<ViteDevServer> {
  return _createServer(inlineConfig, { listen: true })
}

export async function _createServer(
  inlineConfig: ResolvedConfig | InlineConfig | undefined = {},
  options: {
    listen: boolean
    previousEnvironments?: Record<string, DevEnvironment>
    previousShortcutsState?: ShortcutsState<ViteDevServer>
    previousRestartPromise?: Promise<void> | null
    previousForceOptimizeOnRestart?: boolean
  },
): Promise<ViteDevServer> {
  // The dev server is a long-running, interactive process whose outputs
  // (network responses, HMR updates) cannot be replayed from a cache.
  disableCache()

  /**
   * 启动主线第 1 段：先完成 resolveConfig。
   * 用户配置合并、插件排序、内置插件装配和环境插件清单都在这里定稿；
   * 后续服务器和环境只能基于这份 ResolvedConfig 创建。
   */
  const config = isResolvedConfig(inlineConfig)
    ? inlineConfig
    : await resolveConfig(inlineConfig, 'serve')

  if (usedConfigs.has(config)) {
    throw new Error(`There is already a server associated with the config.`)
  }

  if (config.command !== 'serve') {
    throw new Error(
      `Config was resolved for a "build", expected a "serve" command.`,
    )
  }

  usedConfigs.add(config)

  const initPublicFilesPromise = initPublicFiles(config)

  const { root, server: serverConfig } = config
  const httpsOptions = await resolveHttpsConfig(config.server.https)
  const { middlewareMode } = serverConfig

  const resolvedOutDirs = getResolvedOutDirs(
    config.root,
    config.build.outDir,
    config.build.rolldownOptions.output,
  )
  const emptyOutDir = resolveEmptyOutDir(
    config.build.emptyOutDir,
    config.root,
    resolvedOutDirs,
  )
  const resolvedWatchOptions = resolveChokidarOptions(
    {
      disableGlobbing: true,
      ...serverConfig.watch,
    },
    resolvedOutDirs,
    emptyOutDir,
    config.cacheDir,
  )

  /**
   * 启动主线第 2 段：配置定稿后，创建 Connect、HTTP/WS Server 和文件监听器。
   * 这里只是在搭建服务器基础设施，还没有监听端口，也没有启动依赖预构建。
   */
  const middlewares = connect() as Connect.Server
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(middlewares, httpsOptions)

  const ws = createWebSocketServer(httpServer, config, httpsOptions)

  const publicFiles = await initPublicFilesPromise
  const { publicDir } = config

  if (httpServer) {
    setClientErrorHandler(httpServer, config.logger)
  }

  // eslint-disable-next-line eqeqeq
  const watchEnabled = serverConfig.watch !== null
  const watcher = watchEnabled
    ? (chokidar.watch(
        // config file dependencies and env file might be outside of root
        [
          ...(config.experimental.bundledDev ? [] : [root]),
          ...config.configFileDependencies,
          ...getEnvFilesForMode(config.mode, config.envDir),
          // Watch the public directory explicitly because it might be outside
          // of the root directory.
          ...(publicDir && publicFiles ? [publicDir] : []),
        ],

        resolvedWatchOptions,
      ) as FSWatcher)
    : createNoopWatcher(resolvedWatchOptions)

  const environments: Record<string, DevEnvironment> = {}

  /**
   * 启动主线第 3 段：dev server 不再只有一套模块图/插件容器。
   * 这里的 config 是 ResolvedConfig，environmentOptions 也不是用户写下的原始配置，
   * 而是已经补齐默认值和 dev.createEnvironment 工厂的 ResolvedEnvironmentOptions。
   *
   * config.environments 负责“描述环境”，下面调用 createEnvironment 才生成真正的运行时实例。
   * 默认 client 工厂创建浏览器 DevEnvironment，ssr/其它环境创建 RunnableDevEnvironment；
   * 用户也可以在高级场景中通过 dev.createEnvironment 覆盖默认工厂。
   *
   * 这里按 config.environments 并行创建 client、ssr 以及自定义环境，每个环境随后 init 自己的插件容器。
   * 符合条件的 DevEnvironment 会在构造阶段创建 depsOptimizer，但此时只创建对象，不执行 init()。
   */
  await Promise.all(
    Object.entries(config.environments).map(
      async ([name, environmentOptions]) => {
        const environment = await environmentOptions.dev.createEnvironment( // 🔖断点[小册10] 按 config.environments 逐个创建环境(client=DevEnvironment, ssr=Runnable)
          name,
          config,
          {
            ws,
          },
        )
        environments[name] = environment

        const previousInstance =
          options.previousEnvironments?.[environment.name]
        await environment.init({ watcher, previousInstance })
      },
    ),
  )

  /**
   * Backward compatibility
   * server.moduleGraph/server.pluginContainer 是旧 API 门面，真实数据已经拆到各个 environment 里。
   */

  let moduleGraph = new ModuleGraph({ // 🔖断点[小册09/10] server.moduleGraph 兼容门面:读穿透到两张环境图
    client: () => environments.client.moduleGraph,
    ssr: () => environments.ssr.moduleGraph,
  })
  let pluginContainer = createPluginContainer(environments)

  const closeHttpServer = createServerCloseFn(httpServer)

  const devHtmlTransformFn = createDevHtmlTransformFn(config)

  // Promise used by `server.close()` to ensure `closeServer()` is only called once
  let closeServerPromise: Promise<void> | undefined
  const closeServer = async () => {
    if (!middlewareMode) {
      teardownSIGTERMListener(closeServerAndExit)
    }

    await Promise.allSettled([
      watcher.close(),
      ws.close(),
      Promise.allSettled(
        Object.values(server.environments).map((environment) =>
          environment.close(),
        ),
      ),
      closeHttpServer(),
      server._ssrCompatModuleRunner?.close(),
    ])
    server.resolvedUrls = null
    server._ssrCompatModuleRunner = undefined
  }

  let hot = ws
  let server: ViteDevServer = {
    config,
    middlewares,
    httpServer,
    watcher,
    ws,
    get hot() {
      warnFutureDeprecation(config, 'removeServerHot')
      return hot
    },
    set hot(h) {
      hot = h
    },

    environments,
    get pluginContainer() {
      warnFutureDeprecation(config, 'removeServerPluginContainer')
      return pluginContainer
    },
    set pluginContainer(p) {
      pluginContainer = p
    },
    get moduleGraph() {
      warnFutureDeprecation(config, 'removeServerModuleGraph')
      return moduleGraph
    },
    set moduleGraph(graph) {
      moduleGraph = graph
    },

    resolvedUrls: null, // will be set on listen
    ssrTransform(
      code: string,
      inMap: SourceMap | { mappings: '' } | null,
      url: string,
      originalCode = code,
    ) {
      return ssrTransform(code, inMap, url, originalCode, {
        json: {
          stringify:
            config.json.stringify === true && config.json.namedExports !== true,
        },
      })
    },
    transformRequest(url, options) {
      warnFutureDeprecation(config, 'removeServerTransformRequest')
      /**
       * 兼容旧 server.transformRequest(url, { ssr }) API：
       * Environment API 后，ssr 布尔只负责在 client/ssr 两个默认环境间选一个，
       * 真正的 transformRequest 已经下沉到具体 DevEnvironment 上。
       */
      const environment = server.environments[options?.ssr ? 'ssr' : 'client']
      return environment.transformRequest(url)
    },
    warmupRequest(url, options) {
      warnFutureDeprecation(config, 'removeServerWarmupRequest')
      const environment = server.environments[options?.ssr ? 'ssr' : 'client']
      return environment.warmupRequest(url)
    },
    transformIndexHtml(url, html, originalUrl) {
      return devHtmlTransformFn(server, url, html, originalUrl)
    },
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      warnFutureDeprecation(config, 'removeSsrLoadModule')
      return ssrLoadModule(url, server, opts?.fixStacktrace)
    },
    ssrFixStacktrace(e) {
      warnFutureDeprecation(
        config,
        'removeSsrLoadModule',
        "ssrFixStacktrace doesn't need to be used for Environment Module Runners.",
      )
      ssrFixStacktrace(e, server.environments.ssr.moduleGraph)
    },
    ssrRewriteStacktrace(stack: string) {
      warnFutureDeprecation(
        config,
        'removeSsrLoadModule',
        "ssrRewriteStacktrace doesn't need to be used for Environment Module Runners.",
      )
      return ssrRewriteStacktrace(stack, server.environments.ssr.moduleGraph)
        .result
    },
    async reloadModule(module) {
      warnFutureDeprecation(config, 'removeServerReloadModule')
      if (serverConfig.hmr !== false && module.file) {
        // TODO: Should we also update the node moduleGraph for backward compatibility?
        const environmentModule = (module._clientModule ?? module._ssrModule)!
        updateModules(
          environments[environmentModule.environment]!,
          module.file,
          [environmentModule],
          monotonicDateNow(),
        )
      }
    },
    async listen(port?: number, isRestart?: boolean) {
      const hostname = await resolveHostname(config.server.host)
      if (httpServer) {
        httpServer.prependListener('listening', () => {
          server.resolvedUrls = resolveServerUrls(
            httpServer,
            config.server,
            hostname,
            httpsOptions,
            config,
          )
        })
      }
      await startServer(server, hostname, port)
      if (httpServer) {
        if (!isRestart && config.server.open) server.openBrowser()
      }
      return server
    },
    openBrowser() {
      const options = server.config.server
      const url = getServerUrlByHost(server.resolvedUrls, options.host)
      if (url) {
        const path =
          typeof options.open === 'string'
            ? new URL(options.open, url).href
            : url

        // We know the url that the browser would be opened to, so we can
        // start the request while we are awaiting the browser. This will
        // start the crawling of static imports ~500ms before.
        // preTransformRequests needs to be enabled for this optimization.
        if (server.config.server.preTransformRequests) {
          setTimeout(() => {
            const getMethod = path.startsWith('https:') ? httpsGet : httpGet

            getMethod(
              path,
              {
                headers: {
                  // Allow the history middleware to redirect to /index.html
                  Accept: 'text/html',
                },
              },
              (res) => {
                res.on('end', () => {
                  // Ignore response, scripts discovered while processing the entry
                  // will be preprocessed (server.config.server.preTransformRequests)
                })
              },
            )
              .on('error', () => {
                // Ignore errors
              })
              .end()
          }, 0)
        }

        _openBrowser(path, true, server.config.logger)
      } else {
        server.config.logger.warn('No URL available to open in browser')
      }
    },
    async close() {
      if (!closeServerPromise) {
        closeServerPromise = closeServer()
      }
      return closeServerPromise
    },
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(
          server.resolvedUrls,
          serverConfig.host,
          config.logger.info,
        )
      } else if (middlewareMode) {
        throw new Error('Cannot print server URLs in middleware mode.')
      } else {
        throw new Error(
          'Cannot print server URLs before server.listen is called.',
        )
      }
    },
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server, options)
    },
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },

    waitForRequestsIdle(ignoredId?: string): Promise<void> {
      return environments.client.waitForRequestsIdle(ignoredId)
    },

    _setInternalServer(_server: ViteDevServer) {
      // Rebind internal the server variable so functions reference the user
      // server instance after a restart
      server = _server
    },
    _restartPromise: options.previousRestartPromise ?? null,
    _forceOptimizeOnRestart: options.previousForceOptimizeOnRestart ?? false,
    _shortcutsState: options.previousShortcutsState,
  }

  // maintain consistency with the server instance after restarting.
  const reflexServer = new Proxy(server, {
    get: (_, property: keyof ViteDevServer) => {
      return server[property]
    },
    set: (_, property: keyof ViteDevServer, value: never) => {
      server[property] = value
      return true
    },
  })

  const closeServerAndExit = async (_: unknown, exitCode?: number) => {
    try {
      await server.close()
    } finally {
      process.exitCode ??= exitCode ? 128 + exitCode : undefined
      process.exit()
    }
  }

  if (!middlewareMode) {
    setupSIGTERMListener(closeServerAndExit)
  }

  const onHMRUpdate = async (
    type: 'create' | 'delete' | 'update',
    file: string,
  ) => {
    if (serverConfig.hmr !== false) {
      await handleHMRUpdate(type, file, server)
    }
  }

  const onFileAddUnlink = async (file: string, isUnlink: boolean) => {
    file = normalizePath(file)
    reloadOnTsconfigChange(server, file)

    await Promise.all(
      Object.values(server.environments).map((environment) =>
        environment.pluginContainer.watchChange(file, {
          event: isUnlink ? 'delete' : 'create',
        }),
      ),
    )

    if (publicDir && publicFiles) {
      if (file.startsWith(publicDir)) {
        const path = file.slice(publicDir.length)
        publicFiles[isUnlink ? 'delete' : 'add'](path)
        if (!isUnlink) {
          const clientModuleGraph = server.environments.client.moduleGraph
          const moduleWithSamePath =
            await clientModuleGraph.getModuleByUrl(path)
          const etag = moduleWithSamePath?.transformResult?.etag
          if (etag) {
            // The public file should win on the next request over a module with the
            // same path. Prevent the transform etag fast path from serving the module
            clientModuleGraph.etagToModuleMap.delete(etag)
          }
        }
      }
    }
    if (isUnlink) {
      // invalidate module graph cache on file change
      for (const environment of Object.values(server.environments)) {
        environment.moduleGraph.onFileDelete(file)
      }
    }
    await onHMRUpdate(isUnlink ? 'delete' : 'create', file)
  }

  const onFileChange = async (file: string) => {
    file = normalizePath(file)
    reloadOnTsconfigChange(server, file)

    await Promise.all(
      Object.values(server.environments).map((environment) =>
        environment.pluginContainer.watchChange(file, { event: 'update' }),
      ),
    )
    // invalidate module graph cache on file change
    for (const environment of Object.values(server.environments)) {
      environment.moduleGraph.onFileChange(file)
    }
    await onHMRUpdate('update', file)
  }

  /**
   * chokidar 的 change 事件只是 HMR 链路的触发点。
   * 真正顺序在 onFileChange：先 normalize 文件路径，再触发插件 watchChange，
   * 随后让每个 environment 的模块图失效，最后进入 handleHMRUpdate 计算热更新边界。
   */
  watcher.on('change', (file) => { // 🔖断点[小册08] chokidar 文件变更入口,HMR 链路起点
    onFileChange(file).catch((e) => server.config.logger.error(e))
  })

  watcher.on('add', (file) => {
    onFileAddUnlink(file, false).catch((e) => server.config.logger.error(e))
  })
  watcher.on('unlink', (file) => {
    onFileAddUnlink(file, true).catch((e) => server.config.logger.error(e))
  })

  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as net.AddressInfo).port
    })
  }

  /**
   * environment.init() 之后开始组装 Connect 中间件链。
   *
   * Connect 按注册顺序处理请求：当前中间件若结束响应，后面不再执行；
   * 调用 next() 才把请求交给下一层。因此这里的先后顺序就是 dev server 的路由优先级：
   *
   * 1. 调试计时与安全检查
   * 2. 用户 configureServer 前置中间件
   * 3. 缓存、代理、base、public、源码转换与静态文件
   * 4. HTML fallback 和用户 configureServer 返回的后置中间件
   * 5. HTML 转换、404 与最终错误处理
   */
  // Pre applied internal middlewares ------------------------------------------

  // DEBUG 模式下记录每个请求的处理耗时，帮助定位慢请求。
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }

  // 拒绝 URL 中带非法 `#` 的请求，避免后续路径和 server.fs.deny 检查被绕过。
  middlewares.use(rejectInvalidRequestMiddleware())

  // 按 server.cors 为响应添加跨域头；配置为 false 时完全关闭。
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // 校验 Host 请求头，防止通过 DNS rebinding 访问本机 dev server。
  const { allowedHosts } = serverConfig
  // no need to check for HTTPS as HTTPS is not vulnerable to DNS rebinding attacks
  if (allowedHosts !== true && !serverConfig.https) {
    middlewares.use(hostValidationMiddleware(allowedHosts, false))
  }

  // apply configureServer hooks ------------------------------------------------

  const configureServerContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  const postHooks: ((() => void) | void)[] = []
  /**
   * 用户插件可在 configureServer 中立即 middlewares.use(...)：
   * 这些中间件会排在下面的 Vite 内部中间件之前。
   * hook 的返回函数暂存到 postHooks，稍后放到 HTML 处理之前执行注册。
   */
  for (const hook of config.getSortedPluginHooks('configureServer')) {
    postHooks.push(await hook.call(configureServerContext, reflexServer))
  }

  /**
   * 核心逻辑：dev server 的中间件顺序就是请求处理主线。
   * cachedTransform 先尝试 304，public 资源绕过 transform，源码请求进入 transformMiddleware，最后才是 HTML fallback/indexHtml/error。
   */
  // Internal middlewares ------------------------------------------------------

  if (!config.experimental.bundledDev) { // 🔖断点[小册05] 默认 dev 先注册 cachedTransformMiddleware，bundled dev 会跳过
    // 根据 If-None-Match 和模块图中的 etag 快速返回 304，避免重复 transform。
    middlewares.use(cachedTransformMiddleware(server))
  }

  // 命中 server.proxy 规则的请求转发给目标后端，不再进入本地模块处理。
  const { proxy } = serverConfig
  if (proxy) {
    const middlewareServer =
      (isObject(middlewareMode) ? middlewareMode.server : null) || httpServer
    middlewares.use(proxyMiddleware(middlewareServer, proxy, config))
  }

  // 当 base 不是 `/` 时，校验并移除 URL 中的 base 前缀，供后续中间件使用。
  if (config.base !== '/') {
    middlewares.use(baseMiddleware(config.rawBase, !!middlewareMode))
  }

  // 处理错误覆盖层发来的 /__open-in-editor 请求，在本地编辑器打开源码位置。
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // HMR 客户端用特殊 Accept 头探测 dev server 是否存活；这里只返回 204。
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  middlewares.use(function viteHMRPingMiddleware(req, res, next) {
    if (req.headers.accept === 'text/x-vite-ping') {
      res.writeHead(204).end()
    } else {
      next()
    }
  })

  // 直接返回 publicDir 下的静态文件，不经过插件 transform。
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  if (publicDir) {
    middlewares.use(servePublicMiddleware(server, publicFiles))
  }

  if (config.experimental.bundledDev) {
    // bundled dev：按请求触发惰性 bundle，再从内存文件系统返回构建结果。
    middlewares.use(triggerLazyBundlingMiddleware(server))
    middlewares.use(memoryFilesMiddleware(server))
  } else {
    // 普通 dev 的模块请求主入口：进入 transformRequest -> resolveId/load/transform。
    middlewares.use(transformMiddleware(server)) // 🔖断点[小册05] 普通 dev 的源码模块请求从这里进入 transformMiddleware

    // /@fs/ 用于访问 root 外且被允许的文件；随后从项目 root 返回普通静态文件。
    middlewares.use(serveRawFsMiddleware(server))
    middlewares.use(serveStaticMiddleware(server))
  }

  // SPA/MPA HTML fallback：把目录、无扩展名等导航请求改写到对应 HTML。
  if (config.appType === 'spa' || config.appType === 'mpa') {
    middlewares.use(
      htmlFallbackMiddleware(
        root,
        config.appType === 'spa',
        server.environments.client,
      ),
    )
  }

  /**
   * 核心逻辑：configureServer 返回的 post hook 会在 indexHtmlMiddleware 前执行。
   * 因此用户中间件仍有机会拦截 HTML 请求，而不是被 Vite 默认 HTML 处理提前消费。
   */
  // apply configureServer post hooks ------------------------------------------

  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  postHooks.forEach((fn) => fn && fn())

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // 读取并转换 HTML，执行 transformIndexHtml 并注入 Vite client 等内容。
    middlewares.use(indexHtmlMiddleware(root, server))

    // 前面的代理、静态资源、模块和 HTML 都未处理时，返回 404。
    middlewares.use(notFoundMiddleware())
  }

  // 必须放在最后：统一格式化前面通过 next(error) 传下来的异常。
  middlewares.use(errorMiddleware(server, !!middlewareMode))

  /**
   * 启动主线第 4 段：initServer 是“环境已创建”和“HTTP 开始监听”之间的启动闸门。
   * 它保证 buildStart 与 environment.listen 只初始化一次；后者才会真正触发
   * HMR、depsOptimizer.init() 和 warmup。
   *
   * httpServer.listen may be called multiple times when trying the next port,
   * so the in-flight promise and completed flag also prevent duplicate buildStart.
   */
  let initingServer: Promise<void> | undefined
  let serverInited = false
  const initServer = async (onListen: boolean) => {
    if (serverInited) return
    if (initingServer) return initingServer

    initingServer = (async function () {
      if (!config.experimental.bundledDev) {
        // For backward compatibility, we call buildStart for the client
        // environment when initing the server. For other environments
        // buildStart will be called when the first request is transformed
        await environments.client.pluginContainer.buildStart() // 🔖断点[小册07] initServer 主动触发 client 环境 buildStart，兼容 Rollup 生命周期
      }

      // ensure ws server started
      if (onListen || options.listen) {
        await Promise.all(
          Object.values(environments).map((e) => e.listen(server)),
        )
      }

      initingServer = undefined
      serverInited = true
    })()
    return initingServer
  }

  if (!middlewareMode && httpServer) {
    /**
     * 启动主线第 5 段：包装底层 listen，先等待 initServer(true)，再真正绑定端口。
     * depsOptimizer.init() 在冷启动下只会初始化状态并启动后台扫描，
     * 不会阻塞到全部依赖预构建完成后才监听。
     */
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        await initServer(true)
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args)
    }) as any
  } else {
    await initServer(false)
  }

  return server
}

async function startServer(
  server: ViteDevServer,
  hostname: Hostname,
  inlinePort?: number,
): Promise<void> {
  const httpServer = server.httpServer
  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server
  const configPort = inlinePort ?? options.port
  // When using non strict port for the dev server, the running port can be different from the config one.
  // When restarting, the original port may be available but to avoid a switch of URL for the running
  // browser tabs, we enforce the previously used port, expect if the config port changed.
  const port =
    (!configPort || configPort === server._configServerPort
      ? server._currentServerPort
      : configPort) ?? DEFAULT_DEV_PORT
  server._configServerPort = configPort

  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger,
  })
  server._currentServerPort = serverPort
}

export function createServerCloseFn(
  server: HttpServer | null,
): () => Promise<void> {
  if (!server) {
    return () => Promise.resolve()
  }

  let hasListened = false
  const openSockets = new Set<net.Socket>()

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  server.once('listening', () => {
    hasListened = true
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy())
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

const _serverConfigDefaults = Object.freeze({
  port: DEFAULT_DEV_PORT,
  strictPort: false,
  host: 'localhost',
  allowedHosts: [],
  https: undefined,
  open: false,
  proxy: undefined,
  cors: { origin: defaultAllowedOrigins },
  headers: {},
  // hmr
  // ws
  warmup: {
    clientFiles: [],
    ssrFiles: [],
  },
  // watch
  middlewareMode: false,
  fs: {
    strict: true,
    // allow
    deny: [
      '.env',
      '.env.*',
      '*.{crt,pem,key,p12,pfx,cer,der}',
      '.npmrc',
      '.yarnrc.yml',
      '**/.git/**',
    ],
  },
  // origin
  preTransformRequests: true,
  // sourcemapIgnoreList
  perEnvironmentStartEndDuringDev: false,
  perEnvironmentWatchChangeDuringDev: false,
  // hotUpdateEnvironments
  forwardConsole: undefined,
} satisfies ServerOptions)
export const serverConfigDefaults: Readonly<Partial<ServerOptions>> =
  _serverConfigDefaults

const RESERVED_ALLOWED_HOSTS_CHARACTERS_RE = /[\\"']/

export async function resolveServerOptions(
  root: string,
  raw: ServerOptions | undefined,
  logger: Logger,
): Promise<ResolvedServerOptions> {
  const _server = mergeWithDefaults(
    {
      ..._serverConfigDefaults,
      host: undefined, // do not set here to detect whether host is set or not
      sourcemapIgnoreList: isInNodeModules,
    },
    raw ?? {},
  )

  setupHmrWsOptionCompat(_server)

  const workspaceRoot = searchForWorkspaceRoot(root)
  const server: ResolvedServerOptions = {
    ..._server,
    fs: {
      ..._server.fs,
      // run searchForWorkspaceRoot only if needed
      allow: raw?.fs?.allow ?? [workspaceRoot],
    },
    sourcemapIgnoreList:
      _server.sourcemapIgnoreList === false
        ? () => false
        : _server.sourcemapIgnoreList,
    forwardConsole: await resolveForwardConsoleOptions(_server.forwardConsole),
  }

  let allowDirs = server.fs.allow

  const cwd = searchForPackageRoot(root)
  if (process.versions.pnp) {
    // running a command fails if cwd doesn't exist and root may not exist
    // search for package root to find a path that exists
    try {
      const enableGlobalCache =
        execSync('yarn config get enableGlobalCache', { cwd })
          .toString()
          .trim() === 'true'
      const yarnCacheDir = execSync(
        `yarn config get ${enableGlobalCache ? 'globalFolder' : 'cacheFolder'}`,
        { cwd },
      )
        .toString()
        .trim()
      allowDirs.push(yarnCacheDir)
    } catch (e) {
      logger.warn(`Get yarn cache dir error: ${e.message}`, {
        timestamp: true,
      })
    }
  }

  // pnpm's global virtual store (GVS) may place package files outside workspace root.
  // Read node_modules/.modules.yaml which pnpm always writes on install — this works
  // unconditionally regardless of how Vite is launched (node / npx / pnpm run),
  // avoiding the need for subprocess calls or user-agent sniffing.
  // Use workspace root (not package root) because .modules.yaml lives at the
  // monorepo root's node_modules/, not in nested workspace packages.
  const pnpmModulesYaml = path.join(
    workspaceRoot,
    'node_modules',
    '.modules.yaml',
  )
  try {
    const content = fs.readFileSync(pnpmModulesYaml, 'utf-8')
    const parsed = JSON.parse(content)
    const virtualStoreDir = parsed.virtualStoreDir
    if (virtualStoreDir) {
      if (path.isAbsolute(virtualStoreDir)) {
        allowDirs.push(virtualStoreDir)
      } else if (virtualStoreDir.startsWith('..')) {
        allowDirs.push(
          path.resolve(
            path.join(workspaceRoot, 'node_modules'),
            virtualStoreDir,
          ),
        )
      }
    }
  } catch {
    // .modules.yaml not found or unreadable — not a pnpm project, skip
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs.allow = allowDirs

  if (server.origin?.endsWith('/')) {
    server.origin = server.origin.slice(0, -1)
    logger.warn(
      colors.yellow(
        `${colors.bold('(!)')} server.origin should not end with "/". Using "${
          server.origin
        }" instead.`,
      ),
    )
  }

  if (
    process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS &&
    Array.isArray(server.allowedHosts)
  ) {
    const rawAdditionalHosts =
      process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS
    if (RESERVED_ALLOWED_HOSTS_CHARACTERS_RE.test(rawAdditionalHosts)) {
      logger.warn(
        colors.yellow(
          `${colors.bold('(!)')} Skipping additional allowed hosts from environment variable due to reserved characters. Received: "${rawAdditionalHosts}".`,
        ),
      )
    } else {
      const additionalHosts = rawAdditionalHosts
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean)
      server.allowedHosts = [...server.allowedHosts, ...additionalHosts]
    }
  }

  return server
}

async function restartServer(server: ViteDevServer) {
  global.__vite_start_time = performance.now()

  let inlineConfig = server.config.inlineConfig
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      forceOptimizeDeps: true,
    })
  }

  // Reinit the server by creating a new instance using the same inlineConfig
  // This will trigger a reload of the config file and re-create the plugins and
  // middlewares. We then assign all properties of the new server to the existing
  // server instance and set the user instance to be used in the new server.
  // This allows us to keep the same server instance for the user.
  {
    let newServer: ViteDevServer | null = null
    try {
      // delay ws server listen
      newServer = await _createServer(inlineConfig, {
        listen: false,
        previousEnvironments: server.environments,
        previousShortcutsState: server._shortcutsState,
        previousRestartPromise: server._restartPromise,
        previousForceOptimizeOnRestart: server._forceOptimizeOnRestart,
      })
    } catch (err: any) {
      server.config.logger.error(err.message, {
        timestamp: true,
      })
      server.config.logger.error('server restart failed', { timestamp: true })
      return
    }

    // Detach readline so close handler skips it. Reused to avoid stdin issues
    server._shortcutsState = undefined

    await server.close()

    // Assign new server props to existing server instance
    const middlewares = server.middlewares
    newServer._configServerPort = server._configServerPort
    newServer._currentServerPort = server._currentServerPort
    Object.assign(server, newServer)

    // Keep the same connect instance so app.use(vite.middlewares) works
    // after a restart in middlewareMode (.route is always '/')
    middlewares.stack = newServer.middlewares.stack
    server.middlewares = middlewares

    // Rebind internal server variable so functions reference the user server
    newServer._setInternalServer(server)
  }

  const {
    logger,
    server: { port, middlewareMode },
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
  } else {
    await Promise.all(
      Object.values(server.environments).map((e) => e.listen(server)),
    )
  }
  logger.info('server restarted.', { timestamp: true })

  if (
    (server._shortcutsState as ShortcutsState<ViteDevServer> | undefined)
      ?.options
  ) {
    bindCLIShortcuts(
      server,
      { print: false },
      // Skip environment checks since shortcuts were bound before restart
      true,
    )
  }
}

/**
 * Internal function to restart the Vite server and print URLs if changed
 */
export async function restartServerWithUrls(
  server: ViteDevServer,
): Promise<void> {
  if (server.config.server.middlewareMode) {
    await server.restart()
    return
  }

  const { port: prevPort, host: prevHost } = server.config.server
  const prevUrls = server.resolvedUrls

  await server.restart()

  const {
    logger,
    server: { port, host },
  } = server.config
  if (
    (port ?? DEFAULT_DEV_PORT) !== (prevPort ?? DEFAULT_DEV_PORT) ||
    host !== prevHost ||
    diffDnsOrderChange(prevUrls, server.resolvedUrls)
  ) {
    logger.info('')
    server.printUrls()
  }
}
