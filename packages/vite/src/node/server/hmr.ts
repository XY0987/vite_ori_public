import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import colors from 'picocolors'
import type { RollupError } from 'rolldown'
import type { CustomPayload, HotPayload, Update } from '#types/hmrPayload'
import type {
  InvokeMethods,
  InvokeResponseData,
  InvokeSendData,
} from '../../shared/invokeMethods'
import { CLIENT_DIR } from '../constants'
import {
  createDebugger,
  formatAndTruncateFileList,
  monotonicDateNow,
  normalizePath,
} from '../utils'
import type { InferCustomEventPayload, ViteDevServer } from '..'
import { getHookHandler } from '../plugins'
import { isExplicitImportRequired } from '../plugins/importAnalysis'
import { getEnvFilesForMode } from '../env'
import type { Environment } from '../environment'
import { withTrailingSlash, wrapId } from '../../shared/utils'
import type { Plugin } from '../plugin'
import {
  ignoreDeprecationWarnings,
  warnFutureDeprecation,
} from '../deprecations'
import type { EnvironmentModuleNode } from './moduleGraph'
import type { ModuleNode } from './mixedModuleGraph'
import type { DevEnvironment } from './environment'
import { prepareError } from './middlewares/error'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from './pluginContainer'
import type { HttpServer } from '.'
import { restartServerWithUrls } from '.'

export const debugHmr: ((...args: any[]) => any) | undefined =
  createDebugger('vite:hmr')

const whitespaceRE = /\s/

const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface WsOptions {
  protocol?: string
  host?: string
  port?: number
  clientPort?: number
  path?: string
  timeout?: number
  server?: HttpServer
}

export interface HmrOptions {
  /**
   * @deprecated Use `server.ws.protocol` instead.
   */
  protocol?: string
  /**
   * @deprecated Use `server.ws.host` instead.
   */
  host?: string
  /**
   * @deprecated Use `server.ws.port` instead.
   */
  port?: number
  /**
   * @deprecated Use `server.ws.clientPort` instead.
   */
  clientPort?: number
  /**
   * @deprecated Use `server.ws.path` instead.
   */
  path?: string
  /**
   * @deprecated Use `server.ws.timeout` instead.
   */
  timeout?: number
  overlay?: boolean
  /**
   * @deprecated Use `server.ws.server` instead.
   */
  server?: HttpServer
}

export interface HotUpdateOptions {
  type: 'create' | 'update' | 'delete'
  file: string
  timestamp: number
  modules: Array<EnvironmentModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

interface PropagationBoundary {
  boundary: EnvironmentModuleNode & { type: 'js' | 'css' }
  acceptedVia: EnvironmentModuleNode
  isWithinCircularImport: boolean
}

export interface HotChannelClient {
  send(payload: HotPayload): void
}

export type HotChannelListener<T extends string = string> = (
  data: InferCustomEventPayload<T>,
  client: HotChannelClient,
) => void

export interface HotChannel<Api = any> {
  /**
   * When true, the fs access check is skipped in fetchModule.
   * Set this for transports that is not exposed over the network.
   */
  skipFsCheck?: boolean
  /**
   * Broadcast events to all clients
   */
  send?(payload: HotPayload): void
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on?<T extends string>(event: T, listener: HotChannelListener<T>): void
  on?(event: 'connection', listener: () => void): void
  /**
   * Unregister event listener
   */
  off?(event: string, listener: Function): void
  /**
   * Start listening for messages
   */
  listen?(): void
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close?(): Promise<unknown> | void

  api?: Api
}

export function getShortName(file: string, root: string): string {
  return file.startsWith(withTrailingSlash(root))
    ? path.posix.relative(root, file)
    : file
}

export interface NormalizedHotChannelClient {
  /**
   * Send event to the client
   */
  send(payload: HotPayload): void
  /**
   * Send custom event
   */
  send(event: string, payload?: CustomPayload['data']): void
}

export interface NormalizedHotChannel<Api = any> {
  /**
   * Broadcast events to all clients
   */
  send(payload: HotPayload): void
  /**
   * Send custom event
   */
  send<T extends string>(event: T, payload?: InferCustomEventPayload<T>): void
  /**
   * Handle custom event emitted by `import.meta.hot.send`
   */
  on<T extends string>(
    event: T,
    listener: (
      data: InferCustomEventPayload<T>,
      client: NormalizedHotChannelClient,
    ) => void,
  ): void
  /**
   * @deprecated use `vite:client:connect` event instead
   */
  on(event: 'connection', listener: () => void): void
  /**
   * Unregister event listener
   */
  off(event: string, listener: Function): void
  /** @internal */
  setInvokeHandler(invokeHandlers: InvokeMethods | undefined): void
  handleInvoke(payload: HotPayload): Promise<{ result: any } | { error: any }>
  /**
   * Start listening for messages
   */
  listen(): void
  /**
   * Disconnect all clients, called when server is closed or restarted.
   */
  close(): Promise<unknown> | void

  api?: Api
}

export const normalizeHotChannel = (
  channel: HotChannel,
  enableHmr: boolean,
  normalizeClient = true,
): NormalizedHotChannel => {
  const normalizedListenerMap = new WeakMap<
    (data: any, client: NormalizedHotChannelClient) => void | Promise<void>,
    (data: any, client: HotChannelClient) => void | Promise<void>
  >()
  const normalizedClients = new WeakMap<
    HotChannelClient,
    NormalizedHotChannelClient
  >()

  let invokeHandlers: InvokeMethods | undefined
  let listenerForInvokeHandler:
    | ((data: InvokeSendData, client: HotChannelClient) => void)
    | undefined
  const handleInvoke = async <T extends keyof InvokeMethods>(
    payload: HotPayload,
  ) => {
    if (!invokeHandlers) {
      return {
        error: {
          name: 'TransportError',
          message: 'invokeHandlers is not set',
          stack: new Error().stack,
        },
      }
    }

    const data: InvokeSendData<T> = (payload as CustomPayload).data
    const { name, data: args } = data
    try {
      const invokeHandler = invokeHandlers[name]
      // @ts-expect-error `invokeHandler` is `InvokeMethods[T]`, so passing the args is fine
      const result = await invokeHandler(...args)
      return { result }
    } catch (error) {
      return {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          ...error, // preserve enumerable properties such as RollupError.loc, frame, plugin
        },
      }
    }
  }

  return {
    ...channel,
    on: (
      event: string,
      fn: (data: any, client: NormalizedHotChannelClient) => void,
    ) => {
      if (event === 'connection' || !normalizeClient) {
        channel.on?.(event, fn as () => void)
        return
      }

      const listenerWithNormalizedClient = (
        data: any,
        client: HotChannelClient,
      ) => {
        if (!normalizedClients.has(client)) {
          normalizedClients.set(client, {
            send: (...args) => {
              let payload: HotPayload
              if (typeof args[0] === 'string') {
                payload = {
                  type: 'custom',
                  event: args[0],
                  data: args[1],
                }
              } else {
                payload = args[0]
              }
              client.send(payload)
            },
          })
        }
        fn(data, normalizedClients.get(client)!)
      }
      normalizedListenerMap.set(fn, listenerWithNormalizedClient)

      channel.on?.(event, listenerWithNormalizedClient)
    },
    off: (event: string, fn: () => void) => {
      if (event === 'connection' || !normalizeClient) {
        channel.off?.(event, fn as () => void)
        return
      }

      const normalizedListener = normalizedListenerMap.get(fn)
      if (normalizedListener) {
        channel.off?.(event, normalizedListener)
      }
    },
    setInvokeHandler(_invokeHandlers) {
      invokeHandlers = _invokeHandlers
      if (!_invokeHandlers) {
        if (listenerForInvokeHandler) {
          channel.off?.('vite:invoke', listenerForInvokeHandler)
        }
        return
      }

      listenerForInvokeHandler = async (payload, client) => {
        const responseInvoke = payload.id.replace('send', 'response') as
          | 'response'
          | `response:${string}`
        client.send({
          type: 'custom',
          event: 'vite:invoke',
          data: {
            name: payload.name,
            id: responseInvoke,
            data: (await handleInvoke({
              type: 'custom',
              event: 'vite:invoke',
              data: payload,
            }))!,
          } satisfies InvokeResponseData,
        })
      }
      channel.on?.('vite:invoke', listenerForInvokeHandler)
    },
    handleInvoke,
    send: (...args: any[]) => {
      let payload: HotPayload
      if (typeof args[0] === 'string') {
        payload = {
          type: 'custom',
          event: args[0],
          data: args[1],
        }
      } else {
        payload = args[0]
      }

      if (
        enableHmr ||
        payload.type === 'connected' ||
        payload.type === 'ping' ||
        payload.type === 'custom' ||
        payload.type === 'error'
      ) {
        channel.send?.(payload)
      }
    },
    listen() {
      return channel.listen?.()
    },
    close() {
      return channel.close?.()
    },
  }
}

export function getSortedPluginsByHotUpdateHook(
  plugins: readonly Plugin[],
): Plugin[] {
  const sortedPlugins: Plugin[] = []
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  let pre = 0,
    normal = 0,
    post = 0
  for (const plugin of plugins) {
    const hook = plugin.hotUpdate ?? plugin.handleHotUpdate
    if (hook) {
      if (typeof hook === 'object') {
        if (hook.order === 'pre') {
          sortedPlugins.splice(pre++, 0, plugin)
          continue
        }
        if (hook.order === 'post') {
          sortedPlugins.splice(pre + normal + post++, 0, plugin)
          continue
        }
      }
      sortedPlugins.splice(pre + normal++, 0, plugin)
    }
  }

  return sortedPlugins
}

const sortedHotUpdatePluginsCache = new WeakMap<Environment, Plugin[]>()
function getSortedHotUpdatePlugins(environment: Environment): Plugin[] {
  let sortedPlugins = sortedHotUpdatePluginsCache.get(environment)
  if (!sortedPlugins) {
    sortedPlugins = getSortedPluginsByHotUpdateHook(environment.plugins)
    sortedHotUpdatePluginsCache.set(environment, sortedPlugins)
  }
  return sortedPlugins
}

/**
 * 服务端 HMR 总入口。
 * 这里不会直接把新代码推给浏览器，而是判断文件类型、收集各 environment 的受影响模块，
 * 运行插件 hotUpdate/handleHotUpdate 钩子，最后把过滤后的模块交给 updateModules 生成 WS 指令。
 */
export async function handleHMRUpdate( // 🔖断点[小册08] HMR 总入口:收集受影响模块、跑 hotUpdate 钩子
  type: 'create' | 'delete' | 'update',
  file: string,
  server: ViteDevServer,
): Promise<void> {
  const { config } = server
  const mixedModuleGraph = ignoreDeprecationWarnings(() => server.moduleGraph)

  const environments = Object.values(server.environments)
  const shortFile = getShortName(file, config.root)

  const isConfig = file === config.configFile
  const isConfigDependency = config.configFileDependencies.some(
    (name) => file === name,
  )

  const isEnv =
    config.envDir !== false &&
    getEnvFilesForMode(config.mode, config.envDir).includes(file)
  if (isConfig || isConfigDependency || isEnv) { // 🔖断点[小册08] config/env 变化绕过模块级 HMR，直接重启 dev server
    /**
     * 核心逻辑：配置/env 变化不走模块级 HMR，因为插件链、环境和 define 都可能整体变化。
     * 这里直接重启 dev server，是为了避免用旧配置继续处理新请求。
     */
    // auto restart server
    debugHmr?.(`[config change] ${colors.dim(shortFile)}`)
    config.logger.info(
      colors.green(
        `${normalizePath(
          path.relative(process.cwd(), file),
        )} changed, restarting server...`,
      ),
      { clear: true, timestamp: true },
    )
    try {
      await restartServerWithUrls(server)
    } catch (e) {
      config.logger.error(colors.red(e))
    }
    return
  }

  debugHmr?.(`[file change] ${colors.dim(shortFile)}`)

  /**
   * Vite client 本身就是浏览器里的 HMR runtime，不能再依赖它正在执行的 HMR 协议替换自己。
   * dev 模式下只要客户端运行时代码变化，就向所有已连接环境发送 full-reload。
   */
  if (file.startsWith(withTrailingSlash(normalizedClientDir))) {
    environments.forEach(({ hot }) =>
      hot.send({
        type: 'full-reload',
        path: '*',
        triggeredBy: path.resolve(config.root, file),
      }),
    )
    return
  }

  if (config.experimental.bundledDev) {
    /**
     * bundled dev 当前不进入默认逐模块 HMR 主链。
     * 因为它走惰性 bundling/内存文件路径，hotUpdate hooks 与模块边界传播还没有接入。
     */
    // TODO: support handleHotUpdate / hotUpdate
    return
  }

  const timestamp = monotonicDateNow()
  const contextMeta = {
    type,
    file,
    timestamp,
    read: () => readModifiedFile(file),
    server,
  }
  const hotMap = new Map<
    Environment,
    { options: HotUpdateOptions; error?: Error }
  >()

  /**
   * 先按环境分别取受影响模块。Environment API 下 client/ssr 是两张图，
   * 同一个文件在不同环境里可能对应不同模块节点和更新策略。
   */
  for (const environment of Object.values(server.environments)) {
    const mods = new Set(environment.moduleGraph.getModulesByFile(file))
    if (type === 'create') {
      for (const mod of environment.moduleGraph._hasResolveFailedErrorModules) {
        mods.add(mod)
      }
    }
    const options = {
      ...contextMeta,
      modules: [...mods],
    }
    hotMap.set(environment, { options })
  }

  const mixedMods = new Set(mixedModuleGraph.getModulesByFile(file))

  const mixedHmrContext: HmrContext = {
    ...contextMeta,
    modules: [...mixedMods],
  }

  const contextForHandleHotUpdate = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  const clientEnvironment = server.environments.client
  const ssrEnvironment = server.environments.ssr
  const clientContext = clientEnvironment.pluginContainer.minimalContext
  const clientHotUpdateOptions = hotMap.get(clientEnvironment)!.options
  const ssrHotUpdateOptions = hotMap.get(ssrEnvironment)?.options
  try {
    /**
     * 插件可以通过 hotUpdate/handleHotUpdate 接管受影响模块列表。
     * 返回值会覆盖 options.modules：可以收窄无关模块、补充虚拟模块，甚至清空列表。
     * 后面的边界传播只基于这里过滤后的 modules 继续计算。
     */
    for (const plugin of getSortedHotUpdatePlugins( // 🔖断点[小册08] 插件 hotUpdate/handleHotUpdate 可先过滤或替换受影响模块列表
      server.environments.client,
    )) {
      if (plugin.hotUpdate) {
        const filteredModules = await getHookHandler(plugin.hotUpdate).call(
          clientContext,
          clientHotUpdateOptions,
        )
        if (filteredModules) {
          clientHotUpdateOptions.modules = filteredModules
          // Invalidate the hmrContext to force compat modules to be updated
          mixedHmrContext.modules = mixedHmrContext.modules.filter(
            (mixedMod) =>
              filteredModules.some((mod) => mixedMod.id === mod.id) ||
              ssrHotUpdateOptions?.modules.some(
                (ssrMod) => ssrMod.id === mixedMod.id,
              ),
          )
          mixedHmrContext.modules.push(
            ...filteredModules
              .filter(
                (mod) =>
                  !mixedHmrContext.modules.some(
                    (mixedMod) => mixedMod.id === mod.id,
                  ),
              )
              .map((mod) =>
                mixedModuleGraph.getBackwardCompatibleModuleNode(mod),
              ),
          )
        }
      } else if (type === 'update') {
        /**
         * 兼容旧版本插件的 handleHotUpdate 钩子。
         * 新的 Environment API 使用 hotUpdate；旧插件如果还只实现 handleHotUpdate，
         * 这里会把旧的 mixed moduleGraph 结果同步回 client/ssr environment，保证后续 HMR 边界计算还能复用。
         */
        warnFutureDeprecation(
          config,
          'removePluginHookHandleHotUpdate',
          `Used in plugin "${plugin.name}".`,
          false,
        )
        // later on, we'll need: if (runtime === 'client')
        // Backward compatibility with mixed client and ssr moduleGraph
        const filteredModules = await getHookHandler(
          plugin.handleHotUpdate!,
        ).call(contextForHandleHotUpdate, mixedHmrContext)
        if (filteredModules) {
          mixedHmrContext.modules = filteredModules
          clientHotUpdateOptions.modules =
            clientHotUpdateOptions.modules.filter((mod) =>
              filteredModules.some((mixedMod) => mod.id === mixedMod.id),
            )
          clientHotUpdateOptions.modules.push(
            ...(filteredModules
              .filter(
                (mixedMod) =>
                  !clientHotUpdateOptions.modules.some(
                    (mod) => mod.id === mixedMod.id,
                  ),
              )
              .map((mixedMod) => mixedMod._clientModule)
              .filter(Boolean) as EnvironmentModuleNode[]),
          )
          if (ssrHotUpdateOptions) {
            ssrHotUpdateOptions.modules = ssrHotUpdateOptions.modules.filter(
              (mod) =>
                filteredModules.some((mixedMod) => mod.id === mixedMod.id),
            )
            ssrHotUpdateOptions.modules.push(
              ...(filteredModules
                .filter(
                  (mixedMod) =>
                    !ssrHotUpdateOptions.modules.some(
                      (mod) => mod.id === mixedMod.id,
                    ),
                )
                .map((mixedMod) => mixedMod._ssrModule)
                .filter(Boolean) as EnvironmentModuleNode[]),
            )
          }
        }
      }
    }
  } catch (error) {
    hotMap.get(server.environments.client)!.error = error
  }

  for (const environment of Object.values(server.environments)) {
    if (environment.name === 'client') continue
    const hot = hotMap.get(environment)!
    const context = environment.pluginContainer.minimalContext
    try {
      for (const plugin of getSortedHotUpdatePlugins(environment)) {
        if (plugin.hotUpdate) {
          const filteredModules = await getHookHandler(plugin.hotUpdate).call(
            context,
            hot.options,
          )
          if (filteredModules) {
            hot.options.modules = filteredModules
          }
        }
      }
    } catch (error) {
      hot.error = error
    }
  }

  async function hmr(environment: DevEnvironment) {
    try {
      const { options, error } = hotMap.get(environment)!
      if (error) {
        throw error
      }
      if (!options.modules.length) {
        // html file cannot be hot updated
        if (file.endsWith('.html') && environment.name === 'client') {
          environment.logger.info(
            colors.green(`page reload `) + colors.dim(shortFile),
            {
              clear: true,
              timestamp: true,
            },
          )
          environment.hot.send({
            type: 'full-reload',
            path: config.server.middlewareMode
              ? '*'
              : '/' + normalizePath(path.relative(config.root, file)),
          })
        } else {
          // loaded but not in the module graph, probably not js
          debugHmr?.(
            `(${environment.name}) [no modules matched] ${colors.dim(shortFile)}`,
          )
        }
        return
      }

      /**
       * 从“插件过滤后的模块列表”切换到“模块图边界计算”。
       * 每个 environment 独立计算，最终分别通过自己的 hot channel 发送 update/full-reload。
       */
      updateModules(environment, shortFile, options.modules, timestamp) // 🔖断点[小册08] 每个 environment 独立进入模块图 HMR 边界计算
    } catch (err) {
      environment.hot.send({
        type: 'error',
        err: prepareError(err),
      })
    }
  }

  const hotUpdateEnvironments =
    server.config.server.hotUpdateEnvironments ??
    ((server, hmr) => {
      /**
       * 核心逻辑：多环境 HMR 默认并行执行。
       * 框架如果需要先 client 后 ssr，或反过来，可以通过 server.hotUpdateEnvironments 接管调度顺序。
       */
      // Run HMR in parallel for all environments by default
      return Promise.all(
        Object.values(server.environments).map((environment) =>
          hmr(environment),
        ),
      )
    })

  await hotUpdateEnvironments(server, hmr)
}

type HasDeadEnd = string | boolean

export function updateModules(
  environment: DevEnvironment,
  file: string,
  modules: EnvironmentModuleNode[],
  timestamp: number,
  firstInvalidatedBy?: string,
): void {
  const { hot } = environment
  const updates: Update[] = []
  const invalidatedModules = new Set<EnvironmentModuleNode>()
  const traversedModules = new Set<EnvironmentModuleNode>()
  // Modules could be empty if a root module is invalidated via import.meta.hot.invalidate()
  let needFullReload: HasDeadEnd = modules.length === 0

  for (const mod of modules) {
    /**
     * updateModules 把“模块变更”转换成浏览器能消费的 HMR payload。
     * 它先沿模块图找 accept 边界，再失效模块缓存；找不到边界就退化成 full-reload。
     * 观察 boundaries 和 hasDeadEnd，可以判断本次更新为什么能局部替换或为什么必须刷新页面。
     */
    const boundaries: PropagationBoundary[] = [] // 🔖断点[小册08] 从变更模块沿 importers 向上收集可接受更新的边界
    const hasDeadEnd = propagateUpdate(mod, traversedModules, boundaries)

    environment.moduleGraph.invalidateModule(
      mod,
      invalidatedModules,
      timestamp,
      true,
    )

    if (needFullReload) {
      continue
    }

    if (hasDeadEnd) {
      needFullReload = hasDeadEnd
      continue
    }

    // If import.meta.hot.invalidate was called already on that module for the same update,
    // it means any importer of that module can't hot update. We should fallback to full reload.
    if (
      firstInvalidatedBy &&
      boundaries.some(
        ({ acceptedVia }) =>
          normalizeHmrUrl(acceptedVia.url) === firstInvalidatedBy,
      )
    ) {
      needFullReload = 'circular import invalidate'
      continue
    }

    updates.push(
      ...boundaries.map(
        ({ boundary, acceptedVia, isWithinCircularImport }) => ({
          type: `${boundary.type}-update` as const,
          timestamp,
          path: normalizeHmrUrl(boundary.url),
          acceptedPath: normalizeHmrUrl(acceptedVia.url),
          explicitImportRequired:
            boundary.type === 'js'
              ? isExplicitImportRequired(acceptedVia.url)
              : false,
          isWithinCircularImport,
          firstInvalidatedBy,
        }),
      ),
    )
  }

  // html file cannot be hot updated because it may be used as the template for a top-level request response.
  const isClientHtmlChange =
    file.endsWith('.html') &&
    environment.name === 'client' &&
    // if the html file is imported as a module, we assume that this file is
    // not used as the template for top-level request response
    // (i.e. not used by the middleware).
    modules.every((mod) => mod.type !== 'js')

  if (needFullReload || isClientHtmlChange) {
    const reason =
      typeof needFullReload === 'string'
        ? colors.dim(` (${needFullReload})`)
        : ''
    environment.logger.info(
      colors.green(`page reload `) + colors.dim(file) + reason,
      { clear: !firstInvalidatedBy, timestamp: true },
    )
    hot.send({
      type: 'full-reload',
      triggeredBy: path.resolve(environment.config.root, file),
      path:
        !isClientHtmlChange ||
        environment.config.server.middlewareMode ||
        updates.length > 0 // if there's an update, other URLs may be affected
          ? '*'
          : '/' + file,
    })
    return
  }

  if (updates.length === 0) {
    debugHmr?.(colors.yellow(`no update happened `) + colors.dim(file))
    return
  }

  const filePaths = [...new Set(updates.map((u) => u.path))]
  const { formatted, truncated } = formatAndTruncateFileList(filePaths)
  if (truncated) debugHmr?.(`hmr update ${filePaths.join(', ')}`)
  environment.logger.info(colors.green(`hmr update `) + colors.dim(formatted), {
    clear: !firstInvalidatedBy,
    timestamp: true,
  })
  /**
   * 这里发送的是 JSON 指令，不是新代码本身。
   * 浏览器收到 path/acceptedPath 后，会再用带 ?t= 的 URL 重新 import 最新模块。
   */
  hot.send({ // 🔖断点[小册08] 更新 payload 即将通过 WebSocket 推给浏览器
    type: 'update',
    updates,
  })
}

function areAllImportsAccepted(
  importedBindings: Set<string>,
  acceptedExports: Set<string>,
) {
  for (const binding of importedBindings) {
    if (!acceptedExports.has(binding)) {
      return false
    }
  }
  return true
}

function propagateUpdate(
  node: EnvironmentModuleNode,
  traversedModules: Set<EnvironmentModuleNode>,
  boundaries: PropagationBoundary[],
  currentChain: EnvironmentModuleNode[] = [node],
): HasDeadEnd {
  /**
   * 核心逻辑：HMR 不是只看变更模块本身，而是沿 importers 一路向上找“谁 accept 了它”。
   * 找到边界就发 update；一路找不到可接受边界，就返回 dead end 触发 full reload。
   * currentChain 用来识别循环依赖，traversedModules 用来避免同一节点被重复传播。
   */
  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  // #7561
  // if the imports of `node` have not been analyzed, then `node` has not
  // been loaded in the browser and we should stop propagation.
  if (node.id && node.isSelfAccepting === undefined) {
    debugHmr?.(
      `[propagate update] stop propagation because not analyzed: ${colors.dim(
        node.id,
      )}`,
    )
    return false
  }

  if (node.isSelfAccepting) {
    // isSelfAccepting is only true for js and css
    const boundary = node as EnvironmentModuleNode & { type: 'js' | 'css' }
    boundaries.push({
      boundary,
      acceptedVia: boundary,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
    return false
  }

  // A partially accepted module with no importers is considered self accepting,
  // because the deal is "there are parts of myself I can't self accept if they
  // are used outside of me".
  // Also, the imported module (this one) must be updated before the importers,
  // so that they do get the fresh imported module when/if they are reloaded.
  if (node.acceptedHmrExports) {
    // acceptedHmrExports is only true for js and css
    const boundary = node as EnvironmentModuleNode & { type: 'js' | 'css' }
    boundaries.push({
      boundary,
      acceptedVia: boundary,
      isWithinCircularImport: isNodeWithinCircularImports(node, currentChain),
    })
  } else {
    if (!node.importers.size) {
      return true
    }
  }

  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)

    /**
     * importer 通过 import.meta.hot.accept(dep, cb) 明确接受当前依赖。
     * 命中后 importer 成为边界，node 成为 acceptedVia，传播不会再继续向更上层冒泡。
     */
    if (importer.acceptedHmrDeps.has(node)) { // 🔖断点[小册08] 在接受该依赖的导入者处命中 HMR 边界(否则继续向上找,找不到则全量刷新)
      // acceptedHmrDeps has value only for js and css
      const boundary = importer as EnvironmentModuleNode & {
        type: 'js' | 'css'
      }
      boundaries.push({
        boundary,
        acceptedVia: node,
        isWithinCircularImport: isNodeWithinCircularImports(importer, subChain),
      })
      continue
    }

    /**
     * 处理只接受部分导出的场景。
     * 如果 importer 实际使用的导出都在 acceptedHmrExports 内，可以停在当前层；
     * 只要有未被接受的导出，就必须继续向 importer 的上层寻找边界。
     */
    if (node.id && node.acceptedHmrExports && importer.importedBindings) { // 🔖断点[小册08] 判断部分导出 accept 是否覆盖 importer 实际使用的绑定
      const importedBindingsFromNode = importer.importedBindings.get(node.id)
      if (
        importedBindingsFromNode &&
        areAllImportsAccepted(importedBindingsFromNode, node.acceptedHmrExports)
      ) {
        continue
      }
    }

    if (
      !currentChain.includes(importer) &&
      propagateUpdate(importer, traversedModules, boundaries, subChain)
    ) {
      return true
    }
  }
  return false
}

/**
 * Check importers recursively if it's an import loop. An accepted module within
 * an import loop cannot recover its execution order and should be reloaded.
 *
 * @param node The node that accepts HMR and is a boundary
 * @param nodeChain The chain of nodes/imports that lead to the node.
 *   (The last node in the chain imports the `node` parameter)
 * @param currentChain The current chain tracked from the `node` parameter
 * @param traversedModules The set of modules that have traversed
 */
function isNodeWithinCircularImports(
  node: EnvironmentModuleNode,
  nodeChain: EnvironmentModuleNode[],
  currentChain: EnvironmentModuleNode[] = [node],
  traversedModules = new Set<EnvironmentModuleNode>(),
): boolean {
  // To help visualize how each parameter works, imagine this import graph:
  //
  // A -> B -> C -> ACCEPTED -> D -> E -> NODE
  //      ^--------------------------|
  //
  // ACCEPTED: the node that accepts HMR. the `node` parameter.
  // NODE    : the initial node that triggered this HMR.
  //
  // This function will return true in the above graph, which:
  // `node`         : ACCEPTED
  // `nodeChain`    : [NODE, E, D, ACCEPTED]
  // `currentChain` : [ACCEPTED, C, B]
  //
  // It works by checking if any `node` importers are within `nodeChain`, which
  // means there's an import loop with a HMR-accepted module in it.

  if (traversedModules.has(node)) {
    return false
  }
  traversedModules.add(node)

  for (const importer of node.importers) {
    // Node may import itself which is safe
    if (importer === node) continue

    // Check circular imports
    const importerIndex = nodeChain.indexOf(importer)
    if (importerIndex > -1) {
      // Log extra debug information so users can fix and remove the circular imports
      if (debugHmr) {
        // Following explanation above:
        // `importer`                    : E
        // `currentChain` reversed       : [B, C, ACCEPTED]
        // `nodeChain` sliced & reversed : [D, E]
        // Combined                      : [E, B, C, ACCEPTED, D, E]
        const importChain = [
          importer,
          ...[...currentChain].reverse(),
          ...nodeChain.slice(importerIndex, -1).reverse(),
        ]
        debugHmr(
          colors.yellow(`circular imports detected: `) +
            importChain.map((m) => colors.dim(m.url)).join(' -> '),
        )
      }
      return true
    }

    // Continue recursively
    if (!currentChain.includes(importer)) {
      const result = isNodeWithinCircularImports(
        importer,
        nodeChain,
        currentChain.concat(importer),
        traversedModules,
      )
      if (result) return result
    }
  }
  return false
}

export function handlePrunedModules( // 🔖断点[小册08] 发送 prune payload，通知客户端清理孤儿模块副作用
  mods: Set<EnvironmentModuleNode>,
  { hot }: DevEnvironment,
): void {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = monotonicDateNow()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t
    mod.lastHMRInvalidationReceived = false
    debugHmr?.(`[dispose] ${colors.dim(mod.file)}`)
  })
  /**
   * prune payload 用来通知浏览器清理已经不再被页面导入的模块。
   * 客户端会按 paths 执行 dispose/prune 回调，释放样式注入、事件监听等副作用。
   */
  hot.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url),
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray,
}

/**
 * 词法扫描 import.meta.hot.accept(...) 的第一个参数。
 *
 * accept 支持的形态很有限：
 * - accept('./dep', cb)：接受单个依赖更新；
 * - accept(['./a', './b'], cb)：接受多个依赖更新；
 * - accept(cb) / accept()：当前模块自接受。
 *
 * 因为这里只需要识别字符串字面量或字符串数组，没有必要对整份源码跑完整 AST。
 * 扫描到的依赖会写入 urls，返回值表示当前模块是否 self-accepting。
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>,
): boolean {
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  /**
   * 记录一个 accept 依赖。
   * start/end 指向源码中字符串内容的位置，后续 import-analysis 会用它改写 accept 参数。
   */
  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1,
    })
    currentDep = ''
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        /**
         * 在调用参数或数组参数中，只接受字符串字面量、数组括号、逗号和空白。
         * 第一个参数如果不是字符串或数组，就视为 accept(cb) / accept() 这类自接受写法。
         */
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (whitespaceRE.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              /**
               * 第一个参数不是字符串或数组时，说明是 accept(cb) 或 accept()。
               * 这类写法表示当前模块自己能处理自己的更新。
               */
              return true // done
            }
          } else {
            if (char === `]`) {
              return false // done
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        /**
         * 单引号依赖：accept('./foo') 或 accept(['./foo'])。
         * 如果字符串出现在调用第一层，扫完一个依赖就结束；
         * 如果出现在数组里，则回到数组状态继续找下一个字符串。
         */
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        /**
         * 双引号依赖，处理方式与单引号一致。
         */
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        /**
         * 只允许没有 ${} 表达式的模板字符串，例如 accept(`./foo`)。
         * 一旦出现动态表达式，就无法静态确定依赖 URL，直接报错。
         */
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

export function lexAcceptedHmrExports(
  code: string,
  start: number,
  exportNames: Set<string>,
): boolean {
  const urls = new Set<{ url: string; start: number; end: number }>()
  lexAcceptedHmrDeps(code, start, urls)
  for (const { url } of urls) {
    exportNames.add(url)
  }
  return urls.size > 0
}

export function normalizeHmrUrl(url: string): string {
  if (url[0] !== '.' && url[0] !== '/') {
    url = wrapId(url)
  }
  return url
}

function error(pos: number) {
  const err = new Error(
    `import.meta.hot.accept() can only accept string literals or an ` +
      `Array of string literals.`,
  ) as RollupError
  err.pos = pos
  throw err
}

// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
async function readModifiedFile(file: string): Promise<string> {
  const content = await fsp.readFile(file, 'utf-8')
  if (!content) {
    const mtime = (await fsp.stat(file)).mtimeMs

    for (let n = 0; n < 10; n++) {
      await new Promise((r) => setTimeout(r, 10))
      const newMtime = (await fsp.stat(file)).mtimeMs
      if (newMtime !== mtime) {
        break
      }
    }

    return await fsp.readFile(file, 'utf-8')
  } else {
    return content
  }
}

export type ServerHotChannelApi = {
  innerEmitter: EventEmitter
  outsideEmitter: EventEmitter
}

export type ServerHotChannel = HotChannel<ServerHotChannelApi>
export type NormalizedServerHotChannel =
  NormalizedHotChannel<ServerHotChannelApi>

export function createServerHotChannel(): ServerHotChannel {
  const innerEmitter = new EventEmitter()
  const outsideEmitter = new EventEmitter()

  return {
    skipFsCheck: true,
    send(payload: HotPayload) {
      outsideEmitter.emit('send', payload)
    },
    off(event, listener: () => void) {
      innerEmitter.off(event, listener)
    },
    on: ((event: string, listener: () => unknown) => {
      innerEmitter.on(event, listener)
    }) as ServerHotChannel['on'],
    close() {
      innerEmitter.removeAllListeners()
      outsideEmitter.removeAllListeners()
    },
    listen() {
      innerEmitter.emit('connection')
    },
    api: {
      innerEmitter,
      outsideEmitter,
    },
  }
}
