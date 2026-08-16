/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/main/packages/wmr/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseAst as rolldownParseAst } from 'rolldown/parseAst'
import type { ESTree } from 'rolldown/utils'
import type {
  AsyncPluginHooks,
  CustomPluginOptions,
  EmittedFile,
  FunctionPluginHooks,
  ImportKind,
  InputOptions,
  LoadResult,
  ModuleInfo,
  ModuleOptions,
  ModuleType,
  NormalizedInputOptions,
  OutputOptions,
  ParallelPluginHooks,
  PartialNull,
  PartialResolvedId,
  PluginContextMeta,
  ResolvedId,
  RollupError,
  RolldownFsModule as RollupFsModule,
  RollupLog,
  MinimalPluginContext as RollupMinimalPluginContext,
  PluginContext as RollupPluginContext,
  TransformPluginContext as RollupTransformPluginContext,
  SourceDescription,
  SourceMap,
  TransformResult,
} from 'rolldown'
import type { RawSourceMap } from '@jridgewell/remapping'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import MagicString from 'magic-string'
import colors from 'picocolors'
import type { FSWatcher } from '#dep-types/chokidar'
import type { Plugin } from '../plugin'
import {
  combineSourcemaps,
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  isObject,
  normalizePath,
  numberToPos,
  prettifyUrl,
  rolldownVersion,
  rollupVersion,
  timeFrom,
} from '../utils'
import { FS_PREFIX, VERSION as viteVersion } from '../constants'
import {
  createPluginHookUtils,
  getCachedFilterForPlugin,
  getHookHandler,
} from '../plugins'
import { cleanUrl, unwrapId } from '../../shared/utils'
import type { PluginHookUtils } from '../config'
import type { Environment } from '../environment'
import type { Logger } from '../logger'
import {
  isFutureDeprecationEnabled,
  warnFutureDeprecation,
} from '../deprecations'
import type { DevEnvironment } from './environment'
import { buildErrorMessage } from './middlewares/error'
import type {
  EnvironmentModuleGraph,
  EnvironmentModuleNode,
} from './moduleGraph'

// same default value of "moduleInfo.meta" as in Rollup
const EMPTY_OBJECT = Object.freeze({})

const debugSourcemapCombineFilter =
  process.env.DEBUG_VITE_SOURCEMAP_COMBINE_FILTER
const debugSourcemapCombine = createDebugger('vite:sourcemap-combine', {
  onlyWhenFocused: true,
})
const debugResolve = createDebugger('vite:resolve')
const debugPluginResolve = createDebugger('vite:plugin-resolve', {
  onlyWhenFocused: 'vite:plugin',
})
const debugPluginTransform = createDebugger('vite:plugin-transform', {
  onlyWhenFocused: 'vite:plugin',
})
const debugPluginContainerContext = createDebugger(
  'vite:plugin-container-context',
)

export const ERR_CLOSED_SERVER = 'ERR_CLOSED_SERVER'

export function throwClosedServerError(): never {
  const err: any = new Error(
    'The server is being restarted or closed. Request is outdated',
  )
  err.code = ERR_CLOSED_SERVER
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err
}

export interface PluginContainerOptions {
  cwd?: string
  output?: OutputOptions
  modules?: Map<string, { info: ModuleInfo }>
  writeFile?: (name: string, source: string | Uint8Array) => void
}

/**
 * 为某个 Environment 创建真正执行插件 hook 的容器。
 *
 * plugins 作为参数传入，而不是直接读取 environment.plugins，是为了允许
 * createIdResolver 等场景基于同一个 environment 创建不同的插件流水线。
 * 容器创建后会先跑 options hook，得到后续 buildStart/load/transform 要使用的输入选项。
 */
export async function createEnvironmentPluginContainer<
  Env extends Environment = Environment,
>(
  environment: Env,
  plugins: readonly Plugin[],
  watcher?: FSWatcher,
  autoStart = true,
): Promise<EnvironmentPluginContainer<Env>> {
  const container = new EnvironmentPluginContainer(
    environment,
    plugins,
    watcher,
    autoStart,
  )
  // options hook 的结果会作为后续 buildStart/load/transform 的容器级输入选项。
  await container.resolveRolldownOptions()
  return container
}

export type SkipInformation = {
  id: string
  importer: string | undefined
  plugin: Plugin
  called?: boolean
}

class EnvironmentPluginContainer<Env extends Environment = Environment> {
  private _pluginContextMap = new Map<Plugin, PluginContext>()
  private _resolvedRolldownOptions?: InputOptions
  private _processesing = new Set<Promise<any>>()
  private _seenResolves: Record<string, true | undefined> = {}

  // _addedFiles from the `load()` hook gets saved here so it can be reused in the `transform()` hook
  private _moduleNodeToLoadAddedImports = new WeakMap<
    EnvironmentModuleNode,
    Set<string> | null
  >()

  getSortedPluginHooks: PluginHookUtils['getSortedPluginHooks']
  getSortedPlugins: PluginHookUtils['getSortedPlugins']

  moduleGraph: EnvironmentModuleGraph | undefined
  watchFiles: Set<string> = new Set()
  minimalContext: MinimalPluginContext<Env>

  private _started = false
  private _buildStartPromise: Promise<void> | undefined
  private _closed = false

  /**
   * @internal use `createEnvironmentPluginContainer` instead
   */
  constructor(
    public environment: Env,
    public plugins: readonly Plugin[],
    public watcher?: FSWatcher | undefined,
    autoStart = true,
  ) {
    this._started = !autoStart
    this.minimalContext = new MinimalPluginContext(
      { ...basePluginContextMeta, watchMode: true },
      environment,
    )
    const utils = createPluginHookUtils(plugins)
    this.getSortedPlugins = utils.getSortedPlugins
    this.getSortedPluginHooks = utils.getSortedPluginHooks
    this.moduleGraph =
      environment.mode === 'dev' ? environment.moduleGraph : undefined
  }

  private _updateModuleLoadAddedImports(
    id: string,
    addedImports: Set<string> | null,
  ): void {
    const module = this.moduleGraph?.getModuleById(id)
    if (module) {
      this._moduleNodeToLoadAddedImports.set(module, addedImports)
    }
  }

  private _getAddedImports(id: string): Set<string> | null {
    const module = this.moduleGraph?.getModuleById(id)
    return module
      ? this._moduleNodeToLoadAddedImports.get(module) || null
      : null
  }

  /**
   * 返回 dev 模块图中能可靠提供的 ModuleInfo。
   *
   * dev 阶段没有完整的 Rollup 构建图，所以只暴露 id/meta 等受支持字段；
   * 访问其它 build-only 字段时，由 Proxy 明确报错，避免插件拿到看似存在但不可信的数据。
   */
  getModuleInfo(id: string): ModuleInfo | null { // 🔖断点[小册07] dev 只暴露受支持的 ModuleInfo 字段；访问其它字段会由 Proxy 明确报错
    const module = this.moduleGraph?.getModuleById(id)
    if (!module) {
      return null
    }
    if (!module.info) {
      module.info = new Proxy(
        { id, meta: module.meta || EMPTY_OBJECT } as ModuleInfo,
        // throw when an unsupported ModuleInfo property is accessed,
        // so that incompatible plugins fail in a non-cryptic way.
        {
          get(info: any, key: string) {
            if (key in info) {
              return info[key]
            }
            // Don't throw an error when returning from an async function
            if (key === 'then') {
              return undefined
            }
            throw Error(
              `[vite] The "${key}" property of ModuleInfo is not supported.`,
            )
          },
        },
      )
    }
    return module.info ?? null
  }

  // keeps track of hook promises so that we can wait for them all to finish upon closing the server
  private handleHookPromise<T>(maybePromise: undefined | T | Promise<T>) {
    if (!(maybePromise as any)?.then) {
      return maybePromise
    }
    const promise = maybePromise as Promise<T>
    this._processesing.add(promise)
    return promise.finally(() => this._processesing.delete(promise))
  }

  get options(): InputOptions {
    return this._resolvedRolldownOptions!
  }

  async resolveRolldownOptions(): Promise<InputOptions> {
    if (!this._resolvedRolldownOptions) {
      let options = this.environment.config.build.rolldownOptions
      for (const optionsHook of this.getSortedPluginHooks('options')) {
        if (this._closed) {
          throwClosedServerError()
        }
        options =
          (await this.handleHookPromise(
            optionsHook.call(this.minimalContext, options),
          )) || options
      }
      this._resolvedRolldownOptions = options
    }
    return this._resolvedRolldownOptions
  }

  private _getPluginContext(plugin: Plugin) {
    if (!this._pluginContextMap.has(plugin)) {
      this._pluginContextMap.set(plugin, new PluginContext(plugin, this))
    }
    return this._pluginContextMap.get(plugin)!
  }

  /**
   * hookParallel 驱动 buildStart/buildEnd/closeBundle 这类只通知、不关心返回值的 hook。
   *
   * 普通 hook 会立即执行，并把 Promise 放进 parallelPromises，最后统一等待。
   * 声明 sequential 的 hook 是顺序分隔点：先等前面已经启动的普通 hook 全部完成，
   * 再单独执行当前 hook；执行完后，后面的普通 hook 才会进入下一批并行队列。
   */
  private async hookParallel<H extends AsyncPluginHooks & ParallelPluginHooks>( // 🔖断点[小册07] 通知型 hook 默认并行，遇到 sequential 再分批等待
    hookName: H,
    context: (plugin: Plugin) => ThisType<FunctionPluginHooks[H]>,
    args: (plugin: Plugin) => Parameters<FunctionPluginHooks[H]>,
    condition?: (plugin: Plugin) => boolean | undefined,
  ): Promise<void> {
    const parallelPromises: Promise<unknown>[] = []
    for (const plugin of this.getSortedPlugins(hookName)) {
      // Don't throw here if closed, so buildEnd and closeBundle hooks can finish running
      if (condition && !condition(plugin)) continue

      const hook = plugin[hookName]
      const handler: Function = getHookHandler(hook)
      if ((hook as { sequential?: boolean }).sequential) {
        // sequential hook 要等前面那一批并行 hook 全部结束后，才能单独执行。
        await Promise.all(parallelPromises)
        parallelPromises.length = 0
        await handler.apply(context(plugin), args(plugin))
      } else {
        // 普通 hook 立即启动，不在这里 await，继续收集后面的并行任务。
        parallelPromises.push(handler.apply(context(plugin), args(plugin)))
      }
    }
    await Promise.all(parallelPromises)
  }

  /**
   * 补齐 dev 阶段的 buildStart 生命周期。
   *
   * dev server 没有真正的 Rollup build 流程，但插件仍可能依赖 buildStart 做初始化。
   * 这里用 _started/_buildStartPromise 保证只启动一次；并通过 hookParallel 让普通通知型
   * hook 并行执行，遇到 sequential hook 时再单独等待和执行。
   */
  async buildStart(_options?: InputOptions): Promise<void> { // 🔖断点[小册07] dev 模拟 buildStart，并用 promise 保证只启动一次
    if (this._started) {
      // 多个入口同时触发 buildStart 时，后来的调用只等待正在进行的那一次。
      if (this._buildStartPromise) {
        await this._buildStartPromise
      }
      return
    }
    this._started = true
    const config = this.environment.getTopLevelConfig()
    this._buildStartPromise = this.handleHookPromise(
      this.hookParallel(
        'buildStart',
        (plugin) => this._getPluginContext(plugin),
        () => [this.options as NormalizedInputOptions],
        (plugin) => {
          // 默认只在 client 环境模拟一次 buildStart；显式开启后才按环境分别执行。
          return (
            this.environment.name === 'client' ||
            config.server.perEnvironmentStartEndDuringDev ||
            plugin.perEnvironmentStartEndDuringDev
          )
        },
      ),
    ) as Promise<void>
    await this._buildStartPromise
    this._buildStartPromise = undefined
  }

  /**
   * 按插件顺序解析模块 id。
   *
   * resolveId 是 hookFirst：每个插件先经过 skip/skipCalls 与 filter 判断，
   * 只有命中后才以 ResolveIdContext 作为 this 调用 hook；第一个有效返回值会结束遍历。
   * skipCalls 主要服务于 this.resolve()，用于默认跳过当前插件，避免递归调用自己。
   */
  async resolveId(
    rawId: string,
    importer: string | undefined = join(
      this.environment.config.root,
      'index.html',
    ),
    options?: {
      kind?: ImportKind
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      /** @deprecated use `skipCalls` instead */
      skip?: Set<Plugin>
      skipCalls?: readonly SkipInformation[]
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null> {
    if (!this._started) {
      this.buildStart() // 🔖断点[小册07] 首次 resolveId 时惰性触发 buildStart(dev 模拟 Rollup 生命周期)
      await this._buildStartPromise
    }
    const skip = options?.skip
    const skipCalls = options?.skipCalls
    const scan = !!options?.scan
    const ssr = this.environment.config.consumer === 'server'
    const ctx = new ResolveIdContext(this, skip, skipCalls, scan)
    const topLevelConfig = this.environment.getTopLevelConfig()

    const mergedSkip = new Set<Plugin>(skip)
    // skipCalls 记录 this.resolve() 的调用链，用来决定哪些插件本轮应该跳过。
    for (const call of skipCalls ?? []) {
      if (call.called || (call.id === rawId && call.importer === importer)) {
        mergedSkip.add(call.plugin)
      }
    }

    /**
     * 核心逻辑：resolveId/load 都是 hookFirst，命中一个非空结果后就停止。
     * 这也是插件顺序会影响“谁有机会处理这个模块”的根本原因。
     */
    const resolveStart = debugResolve ? performance.now() : 0
    let id: string | null = null
    const partial: Partial<PartialResolvedId> = {}
    for (const plugin of this.getSortedPlugins('resolveId')) {
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()
      if (mergedSkip?.has(plugin)) continue

      const filter = getCachedFilterForPlugin(plugin, 'resolveId') // 🔖断点[小册07] resolveId filter 不命中则完全跳过当前插件
      // 对象式 hook 的 filter 不命中时，连 handler 都不调用，直接看下一个插件。
      if (filter && !filter(rawId)) continue

      ctx._plugin = plugin

      const normalizedOptions = {
        kind: options?.kind,
        attributes: options?.attributes ?? {},
        custom: options?.custom,
        isEntry: !!options?.isEntry,
        ssr,
        scan,
      }
      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        let ssrTemp = ssr
        Object.defineProperty(normalizedOptions, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssrTemp
          },
          set(v) {
            ssrTemp = v
          },
        })
      }

      const pluginResolveStart = debugPluginResolve ? performance.now() : 0
      const handler = getHookHandler(plugin.resolveId)
      const result = await this.handleHookPromise(
        handler.call(ctx as any, rawId, importer, normalizedOptions), // 🔖断点[小册07] resolveId 钩子(hookFirst:第一个非空胜出);看 plugin.name 知道是谁
      )
      if (!result) continue

      if (typeof result === 'string') {
        id = result
      } else {
        id = result.id
        Object.assign(partial, result)
      }

      debugPluginResolve?.(
        timeFrom(pluginResolveStart),
        plugin.name,
        prettifyUrl(id, this.environment.config.root),
      )

      // resolveId() is hookFirst - first non-null result is returned.
      break
    }

    if (debugResolve && rawId !== id && !rawId.startsWith(FS_PREFIX)) {
      const key = rawId + id
      // avoid spamming
      if (!this._seenResolves[key]) {
        this._seenResolves[key] = true
        debugResolve(
          `${timeFrom(resolveStart)} ${colors.cyan(rawId)} -> ${colors.dim(
            id,
          )}`,
        )
      }
    }

    if (id) {
      partial.id = isExternalUrl(id) || id[0] === '\0' ? id : normalizePath(id)
      return partial as PartialResolvedId
    } else {
      return null
    }
  }

  /**
   * 让插件有机会为某个 id 提供源码。
   *
   * load 也是 hookFirst，但它没有 resolveId 的 skip/skipCalls 逻辑，只使用 id filter。
   * 第一个非 null/undefined 的返回值会作为模块内容；如果所有插件都不提供源码，
   * 上层 loadAndTransform() 才会回退到 fs.readFile。
   */
  async load(id: string): Promise<LoadResult | null> {
    let ssr = this.environment.config.consumer === 'server'
    const topLevelConfig = this.environment.getTopLevelConfig()
    const options = { ssr }
    const ctx = new LoadPluginContext(this)
    /**
     * load 与 resolveId 一样是 hookFirst：插件返回内容后，后面的 load 不再执行。
     */
    for (const plugin of this.getSortedPlugins('load')) {
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()

      const filter = getCachedFilterForPlugin(plugin, 'load') // 🔖断点[小册07] load filter 决定插件是否有机会提供源码
      // load 没有 skip 逻辑，只用 id filter 判断当前插件是否关心这个模块。
      if (filter && !filter(id)) continue

      ctx._plugin = plugin

      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        Object.defineProperty(options, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssr
          },
          set(v) {
            ssr = v
          },
        })
      }

      const handler = getHookHandler(plugin.load)
      const result = await this.handleHookPromise(
        handler.call(ctx as any, id, options), // 🔖断点[小册07] load 钩子(hookFirst:第一个非空返回)
      )
      if (result != null) {
        if (isObject(result)) {
          ctx._updateModuleInfo(id, result)
        }
        this._updateModuleLoadAddedImports(id, ctx._addedImports)
        return result
      }
    }
    this._updateModuleLoadAddedImports(id, ctx._addedImports)
    return null
  }

  /**
   * 让所有命中的 transform hook 依次改写模块内容。
   *
   * transform 是 hookSequential：每个插件接收上一轮的 code/moduleType/map，
   * 返回 null/undefined 表示本轮不修改；返回字符串或对象时才更新当前 code、
   * moduleType 或 sourcemapChain，最后统一合并 sourcemap。
   */
  async transform(
    code: string,
    id: string,
    options?: {
      inMap?: SourceDescription['map']
      moduleType?: string
    },
  ): Promise<{
    code: string
    map: SourceMap | { mappings: '' } | null
    moduleType?: ModuleType
  }> {
    let ssr = this.environment.config.consumer === 'server'
    const topLevelConfig = this.environment.getTopLevelConfig()
    const optionsWithSSR = options
      ? { ...options, ssr, moduleType: options.moduleType ?? 'js' }
      : { ssr, moduleType: 'js' }
    const inMap = options?.inMap

    const ctx = new TransformPluginContext(this, id, code, inMap as SourceMap)
    // load hook 里 addWatchFile() 收集到的依赖，在 transform 阶段继续挂到同一个模块上。
    ctx._addedImports = this._getAddedImports(id)

    /**
     * transform 是 hookSequential：所有命中的插件依次执行，code 和 sourcemap 逐步累积。
     */
    for (const plugin of this.getSortedPlugins('transform')) {
      if (this._closed && this.environment.config.dev.recoverable)
        throwClosedServerError()

      const filter = getCachedFilterForPlugin(plugin, 'transform') // 🔖断点[小册07] transform filter 可同时按 id/code/moduleType 跳过插件
      // transform 的 filter 可以同时看 id、当前 code 和 moduleType。
      if (filter && !filter(id, code, optionsWithSSR.moduleType)) continue

      if (
        isFutureDeprecationEnabled(
          topLevelConfig,
          'removePluginHookSsrArgument',
        )
      ) {
        Object.defineProperty(optionsWithSSR, 'ssr', {
          get() {
            warnFutureDeprecation(
              topLevelConfig,
              'removePluginHookSsrArgument',
              `Used in plugin "${plugin.name}".`,
            )
            return ssr
          },
          set(v) {
            ssr = v
          },
        })
      }

      ctx._updateActiveInfo(plugin, id, code)
      const start = debugPluginTransform ? performance.now() : 0
      let result: TransformResult | string | undefined
      const handler = getHookHandler(plugin.transform)
      try {
        result = await this.handleHookPromise(
          handler.call(ctx as any, code, id, optionsWithSSR), // 🔖断点[小册07] transform 钩子(hookSequential:依次链式,code 在插件间传递)
        )
      } catch (e) {
        ctx.error(e)
      }
      if (!result) continue
      debugPluginTransform?.(
        timeFrom(start),
        plugin.name,
        prettifyUrl(id, this.environment.config.root),
      )
      if (isObject(result)) {
        if (result.code !== undefined) {
          code = result.code as string
          if (result.map) {
            if (debugSourcemapCombine) {
              // @ts-expect-error inject plugin name for debug purpose
              result.map.name = plugin.name
            }
            ctx.sourcemapChain.push(result.map) // 🔖断点[小册06] 每个插件的 sourcemap 入链,结束时合并
          }
        }
        if (result.moduleType !== undefined) {
          // moduleType 也会像 code 一样向后传递，影响后续插件如何理解当前内容。
          optionsWithSSR.moduleType = result.moduleType
        }
        ctx._updateModuleInfo(id, result)
      } else {
        code = result
      }
    }
    return {
      code,
      map: ctx._getCombinedSourcemap(),
      moduleType: optionsWithSSR.moduleType,
    }
  }

  async watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void> {
    const config = this.environment.getTopLevelConfig()
    await this.hookParallel(
      'watchChange',
      (plugin) => this._getPluginContext(plugin),
      () => [id, change],
      (plugin) =>
        this.environment.name === 'client' ||
        config.server.perEnvironmentWatchChangeDuringDev ||
        plugin.perEnvironmentWatchChangeDuringDev,
    )
  }

  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    await Promise.allSettled(Array.from(this._processesing))
    const config = this.environment.getTopLevelConfig()
    await this.hookParallel(
      'buildEnd',
      (plugin) => this._getPluginContext(plugin),
      () => [],
      (plugin) =>
        this.environment.name === 'client' ||
        config.server.perEnvironmentStartEndDuringDev ||
        plugin.perEnvironmentStartEndDuringDev,
    )
    await this.hookParallel(
      'closeBundle',
      (plugin) => this._getPluginContext(plugin),
      () => [],
    )
  }
}

export const basePluginContextMeta: {
  viteVersion: string
  rollupVersion: string
  rolldownVersion: string
} = {
  viteVersion,
  rollupVersion,
  rolldownVersion,
}

export class BasicMinimalPluginContext<Meta = PluginContextMeta> {
  constructor(
    public meta: Meta,
    private _logger: Logger,
  ) {}

  // FIXME: properly support this later
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get pluginName(): string {
    return ''
  }

  debug(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(log, [`debug: ${log.message}`], false)
    debugPluginContainerContext?.(msg)
  }

  info(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(log, [`info: ${log.message}`], false)
    this._logger.info(msg, { clear: true, timestamp: true })
  }

  warn(rawLog: string | RollupLog | (() => string | RollupLog)): void {
    const log = this._normalizeRawLog(rawLog)
    const msg = buildErrorMessage(
      log,
      [colors.yellow(`warning: ${log.message}`)],
      false,
    )
    this._logger.warn(msg, { clear: true, timestamp: true })
  }

  error(e: string | RollupError): never {
    const err = (typeof e === 'string' ? new Error(e) : e) as RollupError
    throw err
  }

  private _normalizeRawLog(
    rawLog: string | RollupLog | (() => string | RollupLog),
  ): RollupLog {
    const logValue = typeof rawLog === 'function' ? rawLog() : rawLog
    return typeof logValue === 'string' ? new Error(logValue) : logValue
  }
}

class MinimalPluginContext<T extends Environment = Environment>
  extends BasicMinimalPluginContext
  implements RollupMinimalPluginContext
{
  public environment: T
  constructor(meta: PluginContextMeta, environment: T) {
    super(meta, environment.logger)
    this.environment = environment
  }
}

const fsModule: RollupFsModule = {
  appendFile: fsp.appendFile,
  copyFile: fsp.copyFile,
  mkdir: fsp.mkdir as RollupFsModule['mkdir'],
  mkdtemp: fsp.mkdtemp,
  readdir: fsp.readdir,
  readFile: fsp.readFile as RollupFsModule['readFile'],
  realpath: fsp.realpath,
  rename: fsp.rename,
  rmdir: fsp.rmdir,
  stat: fsp.stat,
  lstat: fsp.lstat,
  unlink: fsp.unlink,
  writeFile: fsp.writeFile,
}

/**
 * 提供给插件 hook 的 Rollup 风格 this 上下文。
 *
 * Vite 在调用 handler.call(ctx, ...) 前会把 ctx._plugin 切到当前插件，
 * 使插件可以通过 this.resolve()/this.parse()/this.addWatchFile() 等 API
 * 继续访问插件容器能力；不适用于 dev 的 build-only API 会显式告警。
 */
class PluginContext
  extends MinimalPluginContext
  implements Omit<RollupPluginContext, 'cache'>
{
  ssr = false
  _scan = false
  _activeId: string | null = null
  _activeCode: string | null = null
  _resolveSkips?: Set<Plugin>
  _resolveSkipCalls?: readonly SkipInformation[]

  override get pluginName(): string {
    return this._plugin.name
  }

  constructor(
    public _plugin: Plugin,
    public _container: EnvironmentPluginContainer,
  ) {
    super(_container.minimalContext.meta, _container.environment)
  }

  fs: RollupFsModule = fsModule

  parse(code: string, opts: any): ESTree.Program {
    return rolldownParseAst(code, opts)
  }

  /**
   * 插件内部调用 this.resolve() 时重新进入容器的 resolveId 流程。
   *
   * 默认 skipSelf 为 true：当前插件会被记录到 skipCalls 中，下一轮 resolveId
   * 会跳过它，避免同一个插件的 resolveId 因 this.resolve() 递归调用自己。
   * 传入 skipSelf: false 时，则沿用已有 skipCalls，不额外跳过当前插件。
   */
  async resolve(
    id: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      isEntry?: boolean
      skipSelf?: boolean
    },
  ): Promise<ResolvedId | null> {
    let skipCalls: readonly SkipInformation[] | undefined
    if (options?.skipSelf === false) {
      skipCalls = this._resolveSkipCalls
    } else if (this._resolveSkipCalls) {
      const skipCallsTemp = [...this._resolveSkipCalls]
      const sameCallIndex = this._resolveSkipCalls.findIndex(
        (c) =>
          c.id === id && c.importer === importer && c.plugin === this._plugin,
      )
      if (sameCallIndex !== -1) {
        skipCallsTemp[sameCallIndex] = {
          ...skipCallsTemp[sameCallIndex],
          called: true,
        }
      } else {
        skipCallsTemp.push({ id, importer, plugin: this._plugin })
      }
      skipCalls = skipCallsTemp
    } else {
      skipCalls = [{ id, importer, plugin: this._plugin }]
    }

    let out = await this._container.resolveId(id, importer, {
      attributes: options?.attributes,
      custom: options?.custom,
      isEntry: !!options?.isEntry,
      skip: this._resolveSkips,
      skipCalls,
      scan: this._scan,
    })
    if (typeof out === 'string') out = { id: out }
    return out as ResolvedId | null
  }

  async load(
    options: {
      id: string
      resolveDependencies?: boolean
    } & Partial<PartialNull<ModuleOptions>>,
  ): Promise<ModuleInfo> {
    // We may not have added this to our module graph yet, so ensure it exists
    await this._container.moduleGraph?.ensureEntryFromUrl(unwrapId(options.id))
    // Not all options passed to this function make sense in the context of loading individual files,
    // but we can at least update the module info properties we support
    this._updateModuleInfo(options.id, options)

    const loadResult = await this._container.load(options.id)
    const code = typeof loadResult === 'object' ? loadResult?.code : loadResult
    if (code != null) {
      await this._container.transform(code, options.id)
    }

    const moduleInfo = this.getModuleInfo(options.id)
    // This shouldn't happen due to calling ensureEntryFromUrl, but 1) our types can't ensure that
    // and 2) moduleGraph may not have been provided (though in the situations where that happens,
    // we should never have plugins calling this.load)
    if (!moduleInfo) throw Error(`Failed to load module with id ${options.id}`)
    return moduleInfo
  }

  getModuleInfo(id: string): ModuleInfo | null {
    return this._container.getModuleInfo(id)
  }

  _updateModuleInfo(id: string, { meta }: { meta?: object | null }): void {
    if (meta) {
      const moduleInfo = this.getModuleInfo(id)
      if (moduleInfo) {
        moduleInfo.meta = { ...moduleInfo.meta, ...meta }
      }
    }
  }

  getModuleIds(): IterableIterator<string> {
    return this._container.moduleGraph
      ? this._container.moduleGraph.idToModuleMap.keys()
      : Array.prototype[Symbol.iterator]()
  }

  addWatchFile(id: string): void {
    this._container.watchFiles.add(id)
    if (this._container.watcher)
      ensureWatchedFile(
        this._container.watcher,
        id,
        this.environment.config.root,
      )
  }

  getWatchFiles(): string[] {
    return [...this._container.watchFiles]
  }

  emitFile(_assetOrFile: EmittedFile): string {
    this._warnIncompatibleMethod(`emitFile`)
    return ''
  }

  setAssetSource(): void {
    this._warnIncompatibleMethod(`setAssetSource`)
  }

  getFileName(): string {
    this._warnIncompatibleMethod(`getFileName`)
    return ''
  }

  override debug(log: string | RollupLog | (() => string | RollupLog)): void {
    const err = this._formatLog(typeof log === 'function' ? log() : log)
    super.debug(err)
  }

  override info(log: string | RollupLog | (() => string | RollupLog)): void {
    const err = this._formatLog(typeof log === 'function' ? log() : log)
    super.info(err)
  }

  override warn(
    log: string | RollupLog | (() => string | RollupLog),
    position?: number | { column: number; line: number },
  ): void {
    const err = this._formatLog(
      typeof log === 'function' ? log() : log,
      position,
    )
    super.warn(err)
  }

  override error(
    e: string | RollupError,
    position?: number | { column: number; line: number },
  ): never {
    // error thrown here is caught by the transform middleware and passed on
    // the error middleware.
    throw this._formatLog(e, position)
  }

  private _formatLog<E extends RollupLog>(
    e: string | E,
    position?: number | { column: number; line: number },
  ): E {
    const err = (typeof e === 'string' ? new Error(e) : e) as E
    if (err.pluginCode) {
      return err // The plugin likely called `this.error`
    }
    err.plugin = this._plugin.name
    if (this._activeId && !err.id) err.id = this._activeId
    if (this._activeCode) {
      err.pluginCode = this._activeCode

      // some rollup plugins, e.g. json, sets err.position instead of err.pos
      const pos = position ?? err.pos ?? (err as any).position

      if (pos != null) {
        let errLocation
        try {
          errLocation = numberToPos(this._activeCode, pos)
        } catch (err2) {
          this.environment.logger.error(
            colors.red(
              `Error in error handler:\n${err2.stack || err2.message}\n`,
            ),
            // print extra newline to separate the two errors
            { error: err2 },
          )
          throw err
        }
        err.loc = err.loc || {
          file: err.id,
          ...errLocation,
        }
        err.frame = err.frame || generateCodeFrame(this._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = this._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column,
        }
        err.frame = err.frame || generateCodeFrame(this._activeCode, err.loc)
      }

      // TODO: move it to overrides
      if (
        this instanceof TransformPluginContext &&
        typeof err.loc?.line === 'number' &&
        typeof err.loc.column === 'number'
      ) {
        const rawSourceMap = this._getCombinedSourcemap()
        if (rawSourceMap && 'version' in rawSourceMap) {
          const traced = new TraceMap(rawSourceMap as any)
          const { source, line, column } = originalPositionFor(traced, {
            line: Number(err.loc.line),
            column: Number(err.loc.column),
          })
          if (source) {
            err.loc = { file: source, line, column }
          }
        }
      }
    } else if (err.loc) {
      if (!err.frame) {
        let code = err.pluginCode
        if (err.loc.file) {
          err.id = normalizePath(err.loc.file)
          if (!code) {
            try {
              code = fs.readFileSync(err.loc.file, 'utf-8')
            } catch {}
          }
        }
        if (code) {
          err.frame = generateCodeFrame(`${code}`, err.loc)
        }
      }
    }

    if (
      typeof err.loc?.column !== 'number' &&
      typeof err.loc?.line !== 'number' &&
      !err.loc?.file
    ) {
      delete err.loc
    }

    return err
  }

  _warnIncompatibleMethod(method: string): void {
    this.environment.logger.warn(
      colors.cyan(`[plugin:${this._plugin.name}] `) +
        colors.yellow(
          `context method ${colors.bold(
            `${method}()`,
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`,
        ),
    )
  }
}

class ResolveIdContext extends PluginContext {
  constructor(
    container: EnvironmentPluginContainer,
    skip: Set<Plugin> | undefined,
    skipCalls: readonly SkipInformation[] | undefined,
    scan: boolean,
  ) {
    super(null!, container)
    this._resolveSkips = skip
    this._resolveSkipCalls = skipCalls
    this._scan = scan
  }
}

class LoadPluginContext extends PluginContext {
  _addedImports: Set<string> | null = null

  constructor(container: EnvironmentPluginContainer) {
    super(null!, container)
  }

  override addWatchFile(id: string): void {
    if (!this._addedImports) {
      this._addedImports = new Set()
    }
    this._addedImports.add(id)
    super.addWatchFile(id)
  }
}

class TransformPluginContext
  extends LoadPluginContext
  implements Omit<RollupTransformPluginContext, 'cache'>
{
  filename: string
  originalCode: string
  originalSourcemap: SourceMap | null = null
  sourcemapChain: NonNullable<SourceDescription['map']>[] = []
  combinedMap: SourceMap | { mappings: '' } | null = null

  constructor(
    container: EnvironmentPluginContainer,
    id: string,
    code: string,
    inMap?: SourceMap | string,
  ) {
    super(container)

    this.filename = id
    this.originalCode = code
    if (inMap) {
      if (debugSourcemapCombine) {
        // @ts-expect-error inject name for debug purpose
        inMap.name = '$inMap'
      }
      this.sourcemapChain.push(inMap)
    }
  }

  _getCombinedSourcemap(): SourceMap | { mappings: '' } | null { // 🔖断点[小册06] sourcemap 在读取时才合并，不在每次 transform 后立即合并
    /**
     * 核心逻辑：sourcemap 是惰性合并的。
     * 每个 transform 插件先把 map 放进 sourcemapChain，真正有人读取时再按顺序叠加到 combinedMap，并清空链避免重复合并。
     */
    if (
      debugSourcemapCombine &&
      debugSourcemapCombineFilter &&
      this.filename.includes(debugSourcemapCombineFilter)
    ) {
      debugSourcemapCombine('----------', this.filename)
      debugSourcemapCombine(this.combinedMap)
      debugSourcemapCombine(this.sourcemapChain)
      debugSourcemapCombine('----------')
    }

    let combinedMap = this.combinedMap
    // { mappings: '' }
    if (
      combinedMap &&
      !('version' in combinedMap) &&
      combinedMap.mappings === ''
    ) {
      this.sourcemapChain.length = 0
      return combinedMap
    }

    for (let m of this.sourcemapChain) {
      if (typeof m === 'string') m = JSON.parse(m)
      if (!('version' in (m as SourceMap))) {
        // { mappings: '' }
        if ((m as SourceMap).mappings === '') {
          combinedMap = { mappings: '' }
          break
        }
        // empty, nullified source map
        combinedMap = null
        break
      }
      if (!combinedMap) {
        const sm = m as SourceMap
        // sourcemap should not include `sources: [null]` (because `sources` should be string) nor
        // `sources: ['']` (because `''` means the path of sourcemap)
        // but MagicString generates this when `filename` option is not set.
        // Rollup supports these and therefore we support this as well
        if (sm.sources.length === 1 && !sm.sources[0]) {
          combinedMap = {
            ...sm,
            sources: [this.filename],
            sourcesContent: [this.originalCode],
          }
        } else {
          combinedMap = sm
        }
      } else {
        combinedMap = combineSourcemaps(cleanUrl(this.filename), [
          m as RawSourceMap,
          combinedMap as RawSourceMap,
        ]) as SourceMap
      }
    }
    if (combinedMap !== this.combinedMap) {
      this.combinedMap = combinedMap
      this.sourcemapChain.length = 0
    }
    return this.combinedMap
  }

  getCombinedSourcemap(): SourceMap {
    const map = this._getCombinedSourcemap()
    if (!map || (!('version' in map) && map.mappings === '')) {
      /**
       * 核心逻辑：没有有效 sourcemap 时仍生成 fallback map。
       * 这样调试器至少能把响应代码映射到当前模块 URL，而不是完全失去源码定位能力。
       */
      return new MagicString(this.originalCode).generateMap({
        includeContent: true,
        hires: 'boundary',
        source: cleanUrl(this.filename),
      }) as SourceMap
    }
    return map
  }

  _updateActiveInfo(plugin: Plugin, id: string, code: string): void {
    this._plugin = plugin
    this._activeId = id
    this._activeCode = code
  }
}

export type {
  EnvironmentPluginContainer,
  TransformPluginContext,
  TransformResult,
}

// Backward compatibility
class PluginContainer {
  constructor(private environments: Record<string, Environment>) {}

  // Backward compatibility
  // Users should call pluginContainer.resolveId (and load/transform) passing the environment they want to work with
  // But there is code that is going to call it without passing an environment, or with the ssr flag to get the ssr environment
  private _getEnvironment(options?: {
    ssr?: boolean
    environment?: Environment
  }) {
    return options?.environment
      ? options.environment
      : this.environments[options?.ssr ? 'ssr' : 'client']
  }

  private _getPluginContainer(options?: {
    ssr?: boolean
    environment?: Environment
  }) {
    return (this._getEnvironment(options) as DevEnvironment).pluginContainer
  }

  getModuleInfo(id: string): ModuleInfo | null {
    const clientModuleInfo = (
      this.environments.client as DevEnvironment
    ).pluginContainer.getModuleInfo(id)
    const ssrModuleInfo = (
      this.environments.ssr as DevEnvironment
    ).pluginContainer.getModuleInfo(id)

    if (clientModuleInfo == null && ssrModuleInfo == null) return null

    return new Proxy({} as any, {
      get: (_, key: string) => {
        // `meta` refers to `ModuleInfo.meta` of both environments, so we also
        // need to merge it here
        if (key === 'meta') {
          const meta: Record<string, any> = {}
          if (ssrModuleInfo) {
            Object.assign(meta, ssrModuleInfo.meta)
          }
          if (clientModuleInfo) {
            Object.assign(meta, clientModuleInfo.meta)
          }
          return meta
        }
        if (clientModuleInfo) {
          if (key in clientModuleInfo) {
            return clientModuleInfo[key as keyof ModuleInfo]
          }
        }
        if (ssrModuleInfo) {
          if (key in ssrModuleInfo) {
            return ssrModuleInfo[key as keyof ModuleInfo]
          }
        }
      },
    })
  }

  get options(): InputOptions {
    return (this.environments.client as DevEnvironment).pluginContainer.options
  }

  // For backward compatibility, buildStart and watchChange are called only for the client environment
  // buildStart is called per environment for a plugin with the perEnvironmentStartEndDuringDev flag
  // watchChange is called per environment for a plugin with the perEnvironmentWatchChangeDuringDev flag

  async buildStart(_options?: InputOptions): Promise<void> {
    return (
      this.environments.client as DevEnvironment
    ).pluginContainer.buildStart(_options)
  }

  async watchChange(
    id: string,
    change: { event: 'create' | 'update' | 'delete' },
  ): Promise<void> {
    return (
      this.environments.client as DevEnvironment
    ).pluginContainer.watchChange(id, change)
  }

  async resolveId(
    rawId: string,
    importer?: string,
    options?: {
      attributes?: Record<string, string>
      custom?: CustomPluginOptions
      /** @deprecated use `skipCalls` instead */
      skip?: Set<Plugin>
      skipCalls?: readonly SkipInformation[]
      ssr?: boolean
      /**
       * @internal
       */
      scan?: boolean
      isEntry?: boolean
    },
  ): Promise<PartialResolvedId | null> {
    return this._getPluginContainer(options).resolveId(rawId, importer, options)
  }

  async load(
    id: string,
    options?: {
      ssr?: boolean
    },
  ): Promise<LoadResult | null> {
    return this._getPluginContainer(options).load(id)
  }

  async transform(
    code: string,
    id: string,
    options?: {
      ssr?: boolean
      environment?: Environment
      inMap?: SourceDescription['map']
    },
  ): Promise<{ code: string; map: SourceMap | { mappings: '' } | null }> {
    return this._getPluginContainer(options).transform(code, id, options)
  }

  async close(): Promise<void> {
    // noop, close will be called for each environment
  }
}

/**
 * server.pluginContainer compatibility
 *
 * The default environment is in buildStart, buildEnd, watchChange, and closeBundle hooks,
 * which are called once for all environments, or when no environment is passed in other hooks.
 * The ssrEnvironment is needed for backward compatibility when the ssr flag is passed without
 * an environment. The defaultEnvironment in the main pluginContainer in the server should be
 * the client environment for backward compatibility.
 **/
export function createPluginContainer(
  environments: Record<string, Environment>,
): PluginContainer {
  return new PluginContainer(environments)
}

export type { PluginContainer }
