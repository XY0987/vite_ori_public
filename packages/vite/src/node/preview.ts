import fs from 'node:fs'
import path from 'node:path'
import sirv from 'sirv'
import compression from '@polka/compression'
import connect from 'connect'
import corsMiddleware from 'cors'
import { disableCache } from '@voidzero-dev/vite-task-client'
import type { Connect } from '#dep-types/connect'
import type {
  HttpServer,
  ResolvedServerOptions,
  ResolvedServerUrls,
} from './server'
import { createServerCloseFn } from './server'
import type { CommonServerOptions } from './http'
import {
  httpServerStart,
  resolveHttpServer,
  resolveHttpsConfig,
  setClientErrorHandler,
} from './http'
import { openBrowser } from './server/openBrowser'
import { baseMiddleware } from './server/middlewares/base'
import { htmlFallbackMiddleware } from './server/middlewares/htmlFallback'
import { indexHtmlMiddleware } from './server/middlewares/indexHtml'
import { notFoundMiddleware } from './server/middlewares/notFound'
import { proxyMiddleware } from './server/middlewares/proxy'
import {
  getServerUrlByHost,
  normalizePath,
  resolveHostname,
  resolveServerUrls,
  setupSIGTERMListener,
  shouldServeFile,
  teardownSIGTERMListener,
} from './utils'
import { printServerUrls } from './logger'
import { bindCLIShortcuts } from './shortcuts'
import type { BindCLIShortcutsOptions, ShortcutsState } from './shortcuts'
import { resolveConfig } from './config'
import type { InlineConfig, ResolvedConfig } from './config'
import { DEFAULT_PREVIEW_PORT } from './constants'
import type { RequiredExceptFor } from './typeUtils'
import { hostValidationMiddleware } from './server/middlewares/hostCheck'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from './server/pluginContainer'
import type { MinimalPluginContextWithoutEnvironment } from './plugin'

export interface PreviewOptions extends CommonServerOptions {}

export interface ResolvedPreviewOptions extends RequiredExceptFor<
  PreviewOptions,
  'host' | 'https' | 'proxy'
> {}

export function resolvePreviewOptions( // 🔖断点[小册12] preview 选项逐字段继承 server，但端口使用独立默认值
  preview: PreviewOptions | undefined,
  server: ResolvedServerOptions,
): ResolvedPreviewOptions {
  // The preview server inherits every CommonServerOption from the `server` config
  // except for the port to enable having both the dev and preview servers running
  // at the same time without extra configuration
  return {
    port: preview?.port ?? DEFAULT_PREVIEW_PORT,
    strictPort: preview?.strictPort ?? server.strictPort,
    host: preview?.host ?? server.host,
    allowedHosts: preview?.allowedHosts ?? server.allowedHosts,
    https: preview?.https ?? server.https,
    open: preview?.open ?? server.open,
    proxy: preview?.proxy ?? server.proxy,
    cors: preview?.cors ?? server.cors,
    headers: preview?.headers ?? server.headers,
  }
}

export interface PreviewServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the preview server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * native Node http server instance
   */
  httpServer: HttpServer
  /**
   * The resolved urls Vite prints on the CLI (URL-encoded). Returns `null`
   * if the server is not listening on any port.
   */
  resolvedUrls: ResolvedServerUrls | null
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Bind CLI shortcuts
   */
  bindCLIShortcuts(options?: BindCLIShortcutsOptions<PreviewServer>): void
  /**
   * @internal
   */
  _shortcutsState?: ShortcutsState<PreviewServer>
}

export type PreviewServerHook = (
  this: MinimalPluginContextWithoutEnvironment,
  server: PreviewServer,
) => (() => void) | void | Promise<(() => void) | void>

/**
 * Starts the Vite server in preview mode, to simulate a production deployment
 */
export async function preview(
  inlineConfig: InlineConfig = {},
): Promise<PreviewServer> {
  // The preview server is a long-running, interactive process whose
  // responses cannot be replayed from a cache.
  disableCache()

  /**
   * 核心逻辑：preview 复用 serve 侧配置解析，但通过 isPreview=true 走 production 形态。
   * 这一步只是拿配置，不会创建 dev server 的模块图和 transform middleware。
   */
  const config = await resolveConfig( // 🔖断点[小册12] preview 配置:command='serve' 但 production + isPreview=true
    inlineConfig,
    'serve',
    'production',
    'production',
    true,
  )

  // preview 只服务 client build 的输出目录，不会再回到源码入口或模块图。
  const clientOutDir = config.environments.client.build.outDir // 🔖断点[小册12] 从 client 环境取 build.outDir
  const distDir = path.resolve(config.root, clientOutDir)
  /**
   * 只在最常见的 CLI preview 场景提前报错。
   * JS API 或 configurePreviewServer 插件可能会自己接管 middlewares/httpServer，
   * 所以 dist 不存在时并不总是立即失败。
   */
  if ( // 🔖断点[小册12] dist 缺失只在 CLI preview 且无插件接管时提前报错
    !fs.existsSync(distDir) &&
    // error if no plugins implement `configurePreviewServer`
    config.plugins.every((plugin) => !plugin.configurePreviewServer) &&
    // error if called in CLI only. programmatic usage could access `httpServer`
    // and affect file serving
    process.argv[1]?.endsWith(path.normalize('bin/vite.js')) &&
    process.argv[2] === 'preview'
  ) {
    throw new Error(
      `The directory "${clientOutDir}" does not exist. Did you build your project?`,
    )
  }

  const httpsOptions = await resolveHttpsConfig(config.preview.https)
  const app = connect() as Connect.Server
  const httpServer = await resolveHttpServer(app, httpsOptions)
  setClientErrorHandler(httpServer, config.logger)

  const options = config.preview
  const logger = config.logger

  const closeHttpServer = createServerCloseFn(httpServer)

  // Promise used by `server.close()` to ensure `closeServer()` is only called once
  let closeServerPromise: Promise<void> | undefined
  const closeServer = async () => {
    teardownSIGTERMListener(closeServerAndExit)
    await closeHttpServer()
    server.resolvedUrls = null
  }

  /**
   * preview server 暴露的是 connect middlewares + 原生 httpServer。
   * 插件可以往 middlewares 里插自定义服务，但这里仍不是 dev server。
   */
  const server: PreviewServer = {
    config,
    middlewares: app,
    httpServer,
    async close() {
      if (!closeServerPromise) {
        closeServerPromise = closeServer()
      }
      return closeServerPromise
    },
    resolvedUrls: null,
    printUrls() {
      if (server.resolvedUrls) {
        printServerUrls(server.resolvedUrls, options.host, logger.info)
      } else {
        throw new Error('Cannot print server URLs before server is listening.')
      }
    },
    bindCLIShortcuts(options) {
      bindCLIShortcuts(server as PreviewServer, options)
    },
  }

  const closeServerAndExit = async (_: unknown, exitCode?: number) => {
    try {
      await server.close()
    } finally {
      process.exitCode ??= exitCode ? 128 + exitCode : undefined
      process.exit()
    }
  }

  setupSIGTERMListener(closeServerAndExit)

  // cors
  const { cors } = config.preview
  if (cors !== false) {
    app.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // host check (to prevent DNS rebinding attacks)
  const { allowedHosts } = config.preview
  // no need to check for HTTPS as HTTPS is not vulnerable to DNS rebinding attacks
  if (allowedHosts !== true && !config.preview.https) {
    app.use(hostValidationMiddleware(allowedHosts, true))
  }

  /**
   * configurePreviewServer 的调用时机在默认静态服务之前。
   * hook 内直接 app.use 注册的是 pre 中间件；返回函数会被收集为 post hook。
   */
  const configurePreviewServerContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: false },
    config.logger,
  )
  const postHooks: ((() => void) | void)[] = []
  for (const hook of config.getSortedPluginHooks('configurePreviewServer')) { // 🔖断点[小册12] configurePreviewServer pre hook 先于静态资源中间件执行
    postHooks.push(await hook.call(configurePreviewServerContext, server))
  }

  // 从这里开始装 Vite 默认 preview 中间件：proxy -> compression -> base -> dist 静态服务。
  const { proxy } = config.preview
  if (proxy) {
    app.use(proxyMiddleware(httpServer, proxy, config))
  }

  /**
   * 核心逻辑：preview 的中间件只围绕 dist 产物服务。
   * 它没有 transformMiddleware、没有模块图更新，也不会触发按需编译；和 dev server 的请求链路刻意分离。
   */
  app.use(compression())

  // base
  if (config.base !== '/') {
    app.use(baseMiddleware(config.rawBase, false))
  }

  /**
   * static assets
   * preview 的边界就在这里：它只把 build 后的 dist 当静态目录服务，不再按需编译源码。
   *
   * sirv 是一个静态文件 middleware 工厂：这里在 preview server 启动装配阶段创建 middleware，
   * 真正读取/响应文件发生在后续每次 HTTP 请求经过 connect 中间件栈时。
   * 它位于 proxy/compression/base 之后、htmlFallbackMiddleware 之前，先尝试直接命中 dist 里的静态资源。
   */
  const headers = config.preview.headers
  const viteAssetMiddleware = (...args: readonly [any, any?, any?]) =>
    sirv(distDir, { // 🔖断点[小册12] preview 的本质:用 sirv 静态服务 dist/(无 transform/无模块图)
      etag: true,
      dev: true,
      extensions: [],
      ignores: false,
      setHeaders(res) {
        if (headers) {
          for (const name in headers) {
            res.setHeader(name, headers[name]!)
          }
        }
      },
      shouldServe(filePath) {
        return shouldServeFile(filePath, distDir)
      },
    })(...args)

  app.use(viteAssetMiddleware)

  // SPA/MPA 的历史路由先 fallback 到 HTML，再交给后面的 HTML middleware 读磁盘文件。
  if (config.appType === 'spa' || config.appType === 'mpa') {
    app.use(htmlFallbackMiddleware(distDir, config.appType === 'spa'))
  }

  // apply post server hooks from plugins
  postHooks.forEach((fn) => fn && fn()) // 🔖断点[小册12] post hook 在静态资源与 HTML fallback 之后、indexHtmlMiddleware 之前执行

  if (config.appType === 'spa' || config.appType === 'mpa') {
    // 复用 HTML middleware，但 preview 分支不会执行 transformIndexHtml。
    const normalizedDistDir = normalizePath(distDir)
    app.use(indexHtmlMiddleware(normalizedDistDir, server))

    // handle 404s
    app.use(notFoundMiddleware())
  }

  // 到这里 middlewares 已经全部装完，最后才绑定端口并计算打印 URL。
  const hostname = await resolveHostname(options.host)

  await httpServerStart(httpServer, {
    port: options.port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger,
  })

  server.resolvedUrls = resolveServerUrls(
    httpServer,
    config.preview,
    hostname,
    httpsOptions,
    config,
  )

  if (options.open) {
    const url = getServerUrlByHost(server.resolvedUrls, options.host)
    if (url) {
      const path =
        typeof options.open === 'string' ? new URL(options.open, url).href : url
      openBrowser(path, true, logger)
    }
  }

  return server as PreviewServer
}
