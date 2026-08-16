import aliasPlugin, { type ResolverFunction } from '@rollup/plugin-alias'
import colors from 'picocolors'
import type { ObjectHook } from 'rolldown'
import {
  viteAliasPlugin as nativeAliasPlugin,
  viteJsonPlugin as nativeJsonPlugin,
  oxcRuntimePlugin,
} from 'rolldown/experimental'
import type { PluginHookUtils, ResolvedConfig } from '../config'
import {
  type HookHandler,
  type Plugin,
  type PluginWithRequiredHook,
} from '../plugin'
import { watchPackageDataPlugin } from '../packages'
import { oxcResolvePlugin } from './resolve'
import { optimizedDepsPlugin } from './optimizedDeps'
import { importAnalysisPlugin } from './importAnalysis'
import { cssAnalysisPlugin, cssPlugin, cssPostPlugin } from './css'
import { assetPlugin } from './asset'
import { clientInjectionsPlugin } from './clientInjections'
import { buildHtmlPlugin, htmlInlineProxyPlugin } from './html'
import { wasmHelperPlugin } from './wasm'
import { modulePreloadPolyfillPlugin } from './modulePreloadPolyfill'
import { webWorkerPlugin } from './worker'
import { preAliasPlugin } from './preAlias'
import { definePlugin } from './define'
import { workerImportMetaUrlPlugin } from './workerImportMetaUrl'
import { assetImportMetaUrlPlugin } from './assetImportMetaUrl'
import { dynamicImportVarsPlugin } from './dynamicImportVars'
import { importGlobPlugin } from './importMetaGlob'
import {
  type PluginFilter,
  type TransformHookFilter,
  createFilterForTransform,
  createIdFilter,
} from './pluginFilter'
import { forwardConsolePlugin } from './forwardConsole'
import { oxcPlugin } from './oxc'
import { esbuildBannerFooterCompatPlugin } from './esbuildBannerFooterCompatPlugin'

export async function resolvePlugins(
  config: ResolvedConfig,
  prePlugins: Plugin[],
  normalPlugins: Plugin[],
  postPlugins: Plugin[],
): Promise<Plugin[]> {
  const isBuild = config.command === 'build'
  const isWorker = config.isWorker
  const anyEnvBundled =
    isBuild || Object.values(config.environments).some((env) => env.isBundled)
  const buildPlugins = anyEnvBundled
    ? (await import('../build')).resolveBuildPlugins(config)
    : { pre: [], post: [] }
  const devtoolsIntegrationPlugin =
    config.devtools.enabled && !isWorker
      ? await loadDevToolsIntegrationPlugin(config)
      : null
  const { modulePreload } = config.build

  /**
   * 核心逻辑：这个数组就是 Vite 的“插件模板”。
   * 用户 pre/normal/post 插件被插入固定槽位，importAnalysisPlugin 则故意放在最后，等前面插件都改完 code 后再改写 import/HMR。
   */
  return [
    optimizedDepsPlugin(),
    !isWorker ? watchPackageDataPlugin(config.packageCache) : null,
    preAliasPlugin(config),
    {
      ...aliasPlugin({
        // @ts-expect-error aliasPlugin receives rollup types
        entries: config.resolve.alias,
        customResolver: viteAliasCustomResolver,
      }),
      applyToEnvironment(environment) {
        /**
         * bundled 环境下如果没有自定义 alias resolver，可以替换成更轻的 nativeAliasPlugin。
         * 这体现了 Environment API：同一个顶层插件在不同环境下可以被保留、移除或替换。
         */
        if (
          environment.config.isBundled &&
          !environment.config.resolve.alias.some((v) => v.customResolver)
        ) {
          return nativeAliasPlugin({
            entries: config.resolve.alias.map((item) => {
              return {
                find: item.find,
                replacement: item.replacement,
              }
            }),
          })
        }
        return true
      },
    } as Plugin,

    ...prePlugins, // 🔖断点[小册03] 用户 enforce:'pre' 插件被插在别名之后、核心插件之前的槽位

    modulePreload !== false && modulePreload.polyfill
      ? modulePreloadPolyfillPlugin()
      : null,
    ...oxcResolvePlugin(
      {
        root: config.root,
        isProduction: config.isProduction,
        isBuild,
        packageCache: config.packageCache,
        asSrc: true,
        optimizeDeps: true,
        externalize: true,
        legacyInconsistentCjsInterop: config.legacy?.inconsistentCjsInterop,
      },
      isWorker
        ? {
            ...config,
            consumer: 'client',
            isBundled: true,
            optimizeDepsPluginNames: [],
          }
        : undefined,
    ),
    htmlInlineProxyPlugin(config),
    cssPlugin(config),
    esbuildBannerFooterCompatPlugin(config),
    // @oxc-project/runtime resolution is handled by rolldown in build
    config.oxc !== false
      ? ({
          ...oxcRuntimePlugin(),
          applyToEnvironment(environment) {
            return !environment.config.isBundled
          },
        } satisfies Plugin)
      : null,
    config.oxc !== false ? oxcPlugin(config) : null, // 🔖断点[专题03] 默认转译开关是 config.oxc(不是 esbuild);要关默认转译需 oxc:false
    nativeJsonPlugin({ ...config.json, minify: isBuild }),
    wasmHelperPlugin(),
    webWorkerPlugin(config),
    assetPlugin(config),
    // for now client only
    config.server.forwardConsole.enabled &&
      forwardConsolePlugin({ environments: ['client'] }),

    ...normalPlugins,

    definePlugin(config),
    cssPostPlugin(config),
    buildHtmlPlugin(config),
    workerImportMetaUrlPlugin(config),
    assetImportMetaUrlPlugin(config),
    ...buildPlugins.pre,
    dynamicImportVarsPlugin(config),
    importGlobPlugin(config),

    ...postPlugins,

    ...buildPlugins.post,
    devtoolsIntegrationPlugin,

    // internal server-only plugins are always applied after everything else
    clientInjectionsPlugin(config),
    cssAnalysisPlugin(config),
    importAnalysisPlugin(config),
  ].filter(Boolean) as Plugin[]
}

async function loadDevToolsIntegrationPlugin(
  config: ResolvedConfig,
): Promise<Plugin | null> {
  try {
    const { DevToolsIntegration } = await import('@vitejs/devtools/integration')
    return DevToolsIntegration({ config })
  } catch (error: any) {
    config.logger.error(
      colors.red(
        `Failed to load Vite DevTools integration: ${error?.message || error?.stack}`,
      ),
      { error },
    )
    return null
  }
}

export function createPluginHookUtils(
  plugins: readonly Plugin[],
): PluginHookUtils {
  /**
   * 把一条“完整插件数组”包装成按 hook 查询的工具。
   *
   * 应用场景：
   * 1. PluginContainer 调用 resolveId/load/transform 时，需要拿到实现了对应 hook 的插件对象；
   * 2. configResolved/configureServer 等流程只需要可直接执行的 hook handler；
   * 3. 顶层配置和每个 environment 都有自己的插件数组，因此会各自创建一套 utils 和缓存。
   *
   * 插件数组在装配完成后不会整体执行。真正运行到某个阶段时，调用方传入 hookName，
   * 这里只筛选、排序该 hook 的参与者。结果按 hookName 惰性缓存，避免每次模块请求都重新遍历完整插件数组。
   */
  const sortedPluginsCache = new Map<keyof Plugin, Plugin[]>()
  function getSortedPlugins<K extends keyof Plugin>(
    hookName: K,
  ): PluginWithRequiredHook<K>[] {
    // 同一个 hook（例如 transform）第一次查询时计算，后续请求直接复用。
    if (sortedPluginsCache.has(hookName))
      return sortedPluginsCache.get(hookName) as PluginWithRequiredHook<K>[]
    // 过滤出实现了该 hook 的插件，并应用 plugin[hookName].order 局部排序。
    const sorted = getSortedPluginsByHook(hookName, plugins)
    sortedPluginsCache.set(hookName, sorted)
    return sorted
  }
  function getSortedPluginHooks<K extends keyof Plugin>(
    hookName: K,
  ): NonNullable<HookHandler<Plugin[K]>>[] {
    // 只需要调用函数时，进一步把插件对象映射成真正的 handler。
    // 对象式 hook（{ order, handler }）也会在 getHookHandler 中解包。
    const plugins = getSortedPlugins(hookName)
    return plugins.map((p) => getHookHandler(p[hookName])).filter(Boolean)
  }

  return {
    getSortedPlugins,
    getSortedPluginHooks,
  }
}

export function getSortedPluginsByHook<K extends keyof Plugin>(
  hookName: K,
  plugins: readonly Plugin[],
): PluginWithRequiredHook<K>[] {
  const sortedPlugins: Plugin[] = []
  /**
   * 核心逻辑：hook.order 是钩子级排序，不改变插件在全局插件数组里的位置。
   * 这里用 pre/normal/post 三个游标原地插入，避免每个 hook 都额外创建三组临时数组。
   */
  // Use indexes to track and insert the ordered plugins directly in the
  // resulting array to avoid creating 3 extra temporary arrays per hook
  let pre = 0,
    normal = 0,
    post = 0
  for (const plugin of plugins) { // 🔖断点[小册03] 钩子级排序:按 hook.order 把实现该钩子的插件重排(与 enforce 正交)
    const hook = plugin[hookName]
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

  return sortedPlugins as PluginWithRequiredHook<K>[]
}

export function getHookHandler<T extends ObjectHook<Function>>(
  hook: T,
): HookHandler<T> {
  return (typeof hook === 'object' ? hook.handler : hook) as HookHandler<T>
}

type FilterForPluginValue = {
  resolveId?: PluginFilter | undefined
  load?: PluginFilter | undefined
  transform?: TransformHookFilter | undefined
}
const filterForPlugin = new WeakMap<Plugin, FilterForPluginValue>()

/**
 * 获取并缓存对象式 hook 上声明的 filter。
 *
 * 插件容器在真正执行 handler.call(ctx, ...) 前会先调用这里拿到过滤函数。
 * resolveId/load 只按 id 过滤；transform 会同时按 id、code、moduleType 过滤。
 * 使用 WeakMap 按插件缓存，避免同一个 hook 在每次模块请求中重复编译 filter。
 */
export function getCachedFilterForPlugin<
  H extends 'resolveId' | 'load' | 'transform',
>(plugin: Plugin, hookName: H): FilterForPluginValue[H] | undefined {
  let filters = filterForPlugin.get(plugin)
  if (filters && hookName in filters) {
    // 同一个插件的同一个 hook filter 只编译一次，后续模块请求直接复用。
    return filters[hookName]
  }

  if (!filters) {
    // WeakMap 以插件对象为 key，不影响插件对象被 GC 回收。
    filters = {}
    filterForPlugin.set(plugin, filters)
  }

  let filter: PluginFilter | TransformHookFilter | undefined
  switch (hookName) {
    case 'resolveId': {
      // resolveId 只需要根据 raw id 决定是否进入插件 hook。
      const rawFilter = extractFilter(plugin.resolveId)?.id
      filters.resolveId = createIdFilter(rawFilter)
      filter = filters.resolveId
      break
    }
    case 'load': {
      // load 阶段已经拿到解析后的 id，也只按 id 过滤。
      const rawFilter = extractFilter(plugin.load)?.id
      filters.load = createIdFilter(rawFilter)
      filter = filters.load
      break
    }
    case 'transform': {
      // transform 可以根据 id、当前 code、moduleType 三个维度决定是否处理。
      const rawFilters = extractFilter(plugin.transform)
      filters.transform = createFilterForTransform(
        rawFilters?.id,
        rawFilters?.code,
        rawFilters?.moduleType,
      )
      filter = filters.transform
      break
    }
  }
  return filter as FilterForPluginValue[H] | undefined
}

function extractFilter<T extends Function, F>(
  hook: ObjectHook<T, { filter?: F }> | undefined,
) {
  return hook && 'filter' in hook && hook.filter ? hook.filter : undefined
}

// Same as `@rollup/plugin-alias` default resolver, but we attach additional meta
// if we can't resolve to something, which will error in `importAnalysis`
export const viteAliasCustomResolver: ResolverFunction = async function (
  id,
  importer,
  options,
) {
  const resolved = await this.resolve(id, importer, options)
  return resolved || { id, meta: { 'vite:alias': { noResolved: true } } }
}
