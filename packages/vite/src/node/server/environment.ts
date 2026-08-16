import colors from 'picocolors'
import type { FetchFunctionOptions, FetchResult } from 'vite/module-runner'
import type { FSWatcher } from '#dep-types/chokidar'
import { BaseEnvironment } from '../baseEnvironment'
import type {
  EnvironmentOptions,
  ResolvedConfig,
  ResolvedEnvironmentOptions,
} from '../config'
import { mergeConfig, monotonicDateNow } from '../utils'
import { fetchModule } from '../ssr/fetchModule'
import type { DepsOptimizer } from '../optimizer'
import { isDepOptimizationDisabled } from '../optimizer'
import {
  createDepsOptimizer,
  createExplicitDepsOptimizer,
} from '../optimizer/optimizer'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../../shared/constants'
import { promiseWithResolvers } from '../../shared/utils'
import type { ViteDevServer } from '../server'
import { EnvironmentModuleGraph } from './moduleGraph'
import type { EnvironmentModuleNode } from './moduleGraph'
import type {
  HotChannel,
  NormalizedHotChannel,
  NormalizedHotChannelClient,
} from './hmr'
import { getShortName, normalizeHotChannel, updateModules } from './hmr'
import type { TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import type { EnvironmentPluginContainer } from './pluginContainer'
import {
  ERR_CLOSED_SERVER,
  createEnvironmentPluginContainer,
} from './pluginContainer'
import { type WebSocketServer, isWebSocketServer } from './ws'
import { warmupFiles } from './warmup'
import { buildErrorMessage } from './middlewares/error'
import { BundledDev } from './bundledDev'

export interface DevEnvironmentContext {
  hot: boolean
  transport?: HotChannel | WebSocketServer
  options?: EnvironmentOptions
  remoteRunner?: {
    inlineSourceMap?: boolean
  }
  depsOptimizer?: DepsOptimizer
  /** @internal used for client environment */
  disableFetchModule?: boolean
  /** @internal used for full bundle mode */
  disableDepsOptimizer?: boolean
}

export class DevEnvironment extends BaseEnvironment {
  mode = 'dev' as const
  moduleGraph: EnvironmentModuleGraph

  depsOptimizer?: DepsOptimizer
  /**
   * @internal
   */
  _remoteRunnerOptions: DevEnvironmentContext['remoteRunner']
  /**
   * @internal
   */
  _skipFsCheck: boolean

  get pluginContainer(): EnvironmentPluginContainer<DevEnvironment> {
    if (!this._pluginContainer)
      throw new Error(
        `${this.name} environment.pluginContainer called before initialized`,
      )
    return this._pluginContainer
  }
  /**
   * @internal
   */
  _pluginContainer: EnvironmentPluginContainer<DevEnvironment> | undefined

  /**
   * @internal
   */
  _closing: boolean = false
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
  /**
   * @internal
   */
  _crawlEndFinder: CrawlEndFinder

  /**
   * Hot channel for this environment. If not provided or disabled,
   * it will be a noop channel that does nothing.
   *
   * @example
   * environment.hot.send({ type: 'full-reload' })
   */
  hot: NormalizedHotChannel

  public bundledDev?: BundledDev

  constructor(
    name: string,
    config: ResolvedConfig,
    context: DevEnvironmentContext,
  ) {
    let options = config.environments[name]
    if (!options) {
      throw new Error(`Environment "${name}" is not defined in the config.`)
    }
    if (context.options) {
      options = mergeConfig(
        options,
        context.options,
      ) as ResolvedEnvironmentOptions
    }
    super(name, config, options)
    if (
      options.isBundled ||
      (name === 'client' && config.experimental.bundledDev)
    ) {
      context.disableDepsOptimizer = true
      this.bundledDev = new BundledDev(this)
    }

    this._pendingRequests = new Map()

    /**
     * 核心逻辑：同一个 URL 在 client/ssr 环境下可能解析成不同结果。
     * 因此模块图必须使用本环境的 pluginContainer.resolveId，避免跨环境复用错误的解析结果。
     */
    this.moduleGraph = new EnvironmentModuleGraph(name, (url: string) => // 🔖断点[小册09/10] DevEnvironment 构造:模块图 resolve 使用本环境插件容器(按环境解析)
      this.pluginContainer!.resolveId(url, undefined),
    )

    this._crawlEndFinder = setupOnCrawlEnd()

    this._remoteRunnerOptions = context.remoteRunner ?? {}
    this._skipFsCheck = !!(
      context.transport &&
      !(isWebSocketServer in context.transport) &&
      context.transport.skipFsCheck
    )

    this.hot = context.transport
      ? isWebSocketServer in context.transport
        ? context.transport
        : normalizeHotChannel(context.transport, context.hot)
      : normalizeHotChannel({}, context.hot)

    this.hot.setInvokeHandler({
      fetchModule: (id, importer, options) => {
        if (context.disableFetchModule) {
          throw new Error('fetchModule is disabled in this environment')
        }
        return this.fetchModule(id, importer, options)
      },
      getBuiltins: async () => {
        return this.config.resolve.builtins.map((builtin) =>
          typeof builtin === 'string'
            ? { type: 'string', value: builtin }
            : { type: 'RegExp', source: builtin.source, flags: builtin.flags },
        )
      },
    })

    this.hot.on(
      'vite:invalidate',
      ({ path, message, firstInvalidatedBy }, client) => {
        this.invalidateModule(
          {
            path,
            message,
            firstInvalidatedBy,
          },
          client,
        )
      },
    )

    /**
     * 依赖预构建是环境级能力：bundled dev 或显式禁用时不创建 optimizer；
     * 启用后再按 noDiscovery 选择两条互斥路径：
     *
     * 1. noDiscovery=false -> createDepsOptimizer
     *    自动发现模式：include 作为首批依赖，同时运行源码 scan，并用真实请求 crawl 补漏。
     *
     * 2. noDiscovery=true -> createExplicitDepsOptimizer
     *    显式模式：不扫描源码、不登记运行时 missing import，只预构建 include。
     *
     * optimizer 对象在构造环境时创建，到 environment.listen() 才真正调用 init。
     */
    if (!context.disableDepsOptimizer) {
      const { optimizeDeps } = this.config
      if (context.depsOptimizer) {
        this.depsOptimizer = context.depsOptimizer
      } else if (isDepOptimizationDisabled(optimizeDeps)) {
        this.depsOptimizer = undefined
      } else {
        this.depsOptimizer = (
          optimizeDeps.noDiscovery
            ? createExplicitDepsOptimizer
            : createDepsOptimizer
        )(this)
      }
    }
  }

  async init(options?: {
    watcher?: FSWatcher
    /**
     * the previous instance used for the environment with the same name
     *
     * when using, the consumer should check if it's an instance generated from the same class or factory function
     */
    previousInstance?: DevEnvironment
  }): Promise<void> {
    if (this._initiated) {
      return
    }
    this._initiated = true
    /**
     * init 只负责创建本环境插件容器，不启动网络监听和预构建。
     * listen() 才会启动 HMR channel、depsOptimizer 和 warmup。
     */
    this._pluginContainer = await createEnvironmentPluginContainer( // 🔖断点[小册10] init():用本环境过滤后的插件创建独立插件容器
      this,
      this.config.plugins,
      options?.watcher,
    )
  }

  /**
   * When the dev server is restarted, the methods are called in the following order:
   * - new instance `init`
   * - previous instance `close`
   * - new instance `listen`
   */
  async listen(server: ViteDevServer): Promise<void> { // 🔖断点[小册10] listen():启动 HMR 通道 + 触发依赖预构建 init() + warmup(预构建在这里才真正开始)
    this.hot.listen()
    await Promise.all([this.bundledDev?.listen(), this.depsOptimizer?.init()])
    warmupFiles(server, this)
  }

  /**
   * Called by the module runner to retrieve information about the specified
   * module. Internally calls `transformRequest` and wraps the result in the
   * format that the module runner understands.
   * This method is not meant to be called manually.
   */
  fetchModule(
    id: string,
    importer?: string,
    options?: FetchFunctionOptions,
  ): Promise<FetchResult> {
    /**
     * 核心逻辑：fetchModule 是 Module Runner/SSR 侧读取模块的入口。
     * 它底层仍复用 transformRequest，只是把结果包装成 runner 能消费的格式；远程 runner 会通过 hot channel invoke。
     */
    return fetchModule(this, id, importer, {
      ...this._remoteRunnerOptions,
      ...options,
    })
  }

  async reloadModule(module: EnvironmentModuleNode): Promise<void> {
    if (this.config.server.hmr !== false && module.file) {
      updateModules(this, module.file, [module], monotonicDateNow())
    }
  }

  transformRequest(url: string): Promise<TransformResult | null> {
    return transformRequest(this, url, { skipFsCheck: this._skipFsCheck })
  }

  async warmupRequest(url: string): Promise<void> {
    if (this.bundledDev) {
      // no-op
      return
    }

    try {
      await transformRequest(this, url, { skipFsCheck: true })
    } catch (e) {
      if (
        e?.code === ERR_OUTDATED_OPTIMIZED_DEP ||
        e?.code === ERR_CLOSED_SERVER
      ) {
        // these are expected errors
        return
      }
      // Unexpected error, log the issue but avoid an unhandled exception
      this.logger.error(
        buildErrorMessage(e, [`Pre-transform error: ${e.message}`], false),
        {
          error: e,
          timestamp: true,
        },
      )
    }
  }

  protected invalidateModule(
    m: {
      path: string
      message?: string
      firstInvalidatedBy: string
    },
    _client: NormalizedHotChannelClient,
  ): void {
    /**
     * 这里不是 EnvironmentModuleGraph.invalidateModule。
     * 这个方法处理浏览器端 HMR runtime 主动发来的 vite:invalidate 消息，
     * 典型场景是自接受模块在客户端执行回调时发现自己处理不了更新，
     * 于是请求服务端从它的 importers 继续向上重新计算 HMR 边界。
     */
    if (this.bundledDev) {
      this.invalidateModule(m, _client)
      return
    }

    /**
     * 客户端传来的 path 是模块 URL，所以这里从 urlToModuleMap 找到环境图节点。
     * 只有已经发生过 HMR、且该模块是 self-accepting、且本轮还没处理过 invalidate 时，
     * 才继续向它的上层 importers 传播，避免一次更新里重复触发。
     */
    const mod = this.moduleGraph.urlToModuleMap.get(m.path)
    if (
      mod &&
      mod.isSelfAccepting &&
      mod.lastHMRTimestamp > 0 &&
      !mod.lastHMRInvalidationReceived
    ) {
      mod.lastHMRInvalidationReceived = true
      this.logger.info(
        colors.yellow(`hmr invalidate `) +
          colors.dim(m.path) +
          (m.message ? ` ${m.message}` : ''),
        { timestamp: true },
      )
      const file = getShortName(mod.file!, this.config.root)
      /**
       * 忽略 self-import，只从真正的上层 importers 继续寻找 HMR 边界。
       * 这一步会重新进入 server/hmr.ts 的 updateModules，而不是直接清当前模块缓存。
       */
      updateModules(
        this,
        file,
        [...mod.importers].filter((imp) => imp !== mod), // ignore self-imports
        mod.lastHMRTimestamp,
        m.firstInvalidatedBy,
      )
    }
  }

  async close(): Promise<void> { // 🔖断点[小册10] 环境级关闭边界：并行回收容器/optimizer/bundledDev/hot，并等待在途请求
    this._closing = true

    this._crawlEndFinder.cancel()
    await Promise.allSettled([
      this.pluginContainer.close(),
      this.bundledDev?.close(),
      this.depsOptimizer?.close(),
      // WebSocketServer is independent of HotChannel and should not be closed on environment close
      isWebSocketServer in this.hot ? Promise.resolve() : this.hot.close(),
      (async () => {
        while (this._pendingRequests.size > 0) {
          await Promise.allSettled(
            [...this._pendingRequests.values()].map(
              (pending) => pending.request,
            ),
          )
        }
      })(),
    ])
  }

  /**
   * Calling `await environment.waitForRequestsIdle(id)` will wait until all static imports
   * are processed after the first transformRequest call. If called from a load or transform
   * plugin hook, the id needs to be passed as a parameter to avoid deadlocks.
   * Calling this function after the first static imports section of the module graph has been
   * processed will resolve immediately.
   * @experimental
   */
  waitForRequestsIdle(ignoredId?: string): Promise<void> {
    return this._crawlEndFinder.waitForRequestsIdle(ignoredId)
  }

  /**
   * @internal
   */
  _registerRequestProcessing(id: string, done: () => Promise<unknown>): void {
    this._crawlEndFinder.registerRequestProcessing(id, done)
  }
}

const callCrawlEndIfIdleAfterMs = 50

interface CrawlEndFinder {
  registerRequestProcessing: (id: string, done: () => Promise<any>) => void
  waitForRequestsIdle: (ignoredId?: string) => Promise<void>
  cancel: () => void
}

function setupOnCrawlEnd(): CrawlEndFinder {
  /**
   * 核心逻辑：crawlEndFinder 连接 dev 请求转换和依赖预构建。
   * transformRequest 会登记正在处理的模块；当一段时间内没有新请求后，optimizer 才认为首轮静态 import crawl 结束。
   */
  const registeredIds = new Set<string>()
  const seenIds = new Set<string>()
  const onCrawlEndPromiseWithResolvers = promiseWithResolvers<void>()

  let timeoutHandle: NodeJS.Timeout | undefined

  let cancelled = false
  function cancel() {
    cancelled = true
  }

  function registerRequestProcessing(
    id: string,
    done: () => Promise<any>,
  ): void {
    if (!seenIds.has(id)) {
      seenIds.add(id)
      registeredIds.add(id)
      done()
        .catch(() => {})
        .finally(() => markIdAsDone(id))
    }
  }

  function waitForRequestsIdle(ignoredId?: string): Promise<void> {
    if (ignoredId) {
      seenIds.add(ignoredId)
      markIdAsDone(ignoredId)
    } else {
      checkIfCrawlEndAfterTimeout()
    }
    return onCrawlEndPromiseWithResolvers.promise
  }

  function markIdAsDone(id: string): void {
    registeredIds.delete(id)
    checkIfCrawlEndAfterTimeout()
  }

  function checkIfCrawlEndAfterTimeout() {
    if (cancelled || registeredIds.size > 0) return

    if (timeoutHandle) clearTimeout(timeoutHandle)
    timeoutHandle = setTimeout(
      callOnCrawlEndWhenIdle,
      callCrawlEndIfIdleAfterMs,
    )
  }
  function callOnCrawlEndWhenIdle() {
    if (cancelled || registeredIds.size > 0) return
    onCrawlEndPromiseWithResolvers.resolve()
  }

  return {
    registerRequestProcessing,
    waitForRequestsIdle,
    cancel,
  }
}
