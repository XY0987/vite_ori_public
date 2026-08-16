import fsp from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import getEtag from 'etag'
import MagicString from 'magic-string'
import { init, parse as parseImports } from 'es-module-lexer'
import type {
  ModuleType,
  PartialResolvedId,
  SourceDescription,
  SourceMap,
} from 'rolldown'
import colors from 'picocolors'
import type { EnvironmentModuleNode } from '../server/moduleGraph'
import {
  createDebugger,
  ensureWatchedFile,
  injectQuery,
  isObject,
  monotonicDateNow,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  stripBase,
  timeFrom,
} from '../utils'
import { ssrTransform } from '../ssr/ssrTransform'
import { checkPublicFile } from '../publicDir'
import { cleanUrl, slash, unwrapId } from '../../shared/utils'
import {
  applySourcemapIgnoreList,
  extractSourcemapFromFile,
  injectSourcesContent,
} from './sourcemap'
import { isFileLoadingAllowed } from './middlewares/static'
import { throwClosedServerError } from './pluginContainer'
import type { DevEnvironment } from './environment'
import { isServerAccessDeniedForTransform } from './middlewares/transform'

export const ERR_LOAD_URL = 'ERR_LOAD_URL'
export const ERR_LOAD_PUBLIC_URL = 'ERR_LOAD_PUBLIC_URL'
export const ERR_DENIED_ID = 'ERR_DENIED_ID'

const debugLoad = createDebugger('vite:load')
const debugTransform = createDebugger('vite:transform')
const debugCache = createDebugger('vite:cache')

export interface TransformResult {
  code: string
  map: SourceMap | { mappings: '' } | null
  ssr?: boolean
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}

export interface TransformOptions {
  /**
   * @deprecated inferred from environment
   */
  ssr?: boolean
}

interface TransformOptionsInternal {
  /**
   * Whether to skip the `server.fs` check.
   */
  skipFsCheck: boolean
}

// TODO: This function could be moved to the DevEnvironment class.
// It was already using private fields from the server before, and it now does
// the same with environment._closing, environment._pendingRequests and
// environment._registerRequestProcessing. Maybe it makes sense to keep it in
// separate file to preserve the history or keep the DevEnvironment class cleaner,
// but conceptually this is: `environment.transformRequest(url, options)`

export function transformRequest( // 🔖断点[小册05] 单模块请求入口:_pendingRequests 并发去重就在这里
  environment: DevEnvironment,
  url: string,
  options: TransformOptionsInternal,
): Promise<TransformResult | null> {
  /**
   * transformRequest 是单模块按需转换的统一入口。
   * 浏览器 HTTP、SSR/Module Runner 等上层入口最终都会把 URL 交给这里，
   * 这里先处理 server 关闭、URL 归一化和同 URL 并发去重，再进入 doTransform。
   */
  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  /**
   * 模块可能在转换过程中被失效，例如：
   * 1. 发现缺失依赖后触发重新预构建，需要整页刷新；
   * 2. 配置变更后触发整页刷新；
   * 3. 生成该模块的源文件发生变化；
   * 4. 虚拟模块被主动失效。
   *
   * 所以这里记录本次转换开始时间，后面和模块最后一次失效时间比较。
   * 如果转换开始后模块又失效，本次结果就是过期结果，不能继续写入缓存。
   */
  const timestamp = monotonicDateNow()

  /**
   * ?t=xxx 只用于让浏览器绕过 HTTP 缓存，同一个模块在 moduleGraph 和
   * _pendingRequests 里应该使用去掉时间戳后的稳定 URL。
   */
  url = removeTimestampQuery(url)

  const pending = environment._pendingRequests.get(url) // 🔖断点[小册05] 同 URL 并发转换先查 pending，必要时复用或丢弃重跑
  if (pending) {
    /**
     * 核心逻辑：同一 URL 并发请求会复用 _pendingRequests。
     * 但如果 pending 开始后模块又被失效，就必须丢弃旧请求并重跑，避免把过期 transformResult 写回缓存。
     */
    return environment.moduleGraph.getModuleByUrl(url).then((module) => {
      if (!module || pending.timestamp > module.lastInvalidationTimestamp) {
        // 进行中的请求仍然有效，后来的同 URL 请求直接复用它的 Promise。
        return pending.request
      } else {
        /**
         * 请求 1 开始后，模块被失效；请求 2 再进来时，不能复用请求 1。
         * 这里先 abort 清理旧 pending，再递归发起一次新的 transformRequest。
         */
        pending.abort()
        return transformRequest(environment, url, options)
      }
    })
  }

  const request = doTransform(environment, url, options, timestamp)

  /**
   * abort 和 finally 都会尝试清理 pending。
   * cleared 用来保证只删一次，避免旧请求完成时误删后续新请求登记的 pending。
   */
  let cleared = false
  const clearCache = () => {
    if (!cleared) {
      environment._pendingRequests.delete(url)
      cleared = true
    }
  }

  /**
   * 把本次转换登记为进行中的请求。
   * 在它完成前，后续同 URL 请求都会先命中 _pendingRequests，而不是重复跑 doTransform。
   */
  environment._pendingRequests.set(url, {
    request,
    timestamp,
    abort: clearCache,
  })

  return request.finally(clearCache)
}

async function doTransform( // 🔖断点[小册05] 共享转换内核:先查缓存/resolveId，再进入 loadAndTransform
  environment: DevEnvironment,
  url: string,
  options: TransformOptionsInternal,
  timestamp: number,
) {
  const { pluginContainer } = environment

  /**
   * doTransform 负责把一个稳定 URL 推进到真正的 loadAndTransform。
   * 这里不急着进入插件 load，而是先围绕 moduleGraph 做两层缓存判断：
   * 先按浏览器 URL 查，再 resolve 成内部 id 后按 id 查。
   *
   * 核心逻辑：同一个模块可能被多个 URL 命中，所以先按 url 查缓存，
   * resolve 后还会按 id 再查一次，避免重复 load/transform。
   */
  let module = await environment.moduleGraph.getModuleByUrl(url)
  if (module) {
    // 先尝试复用按 URL 命中的模块缓存。
    const cached = await getCachedTransformResult(
      environment,
      url,
      module,
      timestamp,
    )
    if (cached) return cached
  }

  /**
   * URL 缓存没命中时，才调用插件容器的 resolveId。
   * 这一步会把浏览器请求 URL 解析成 Vite 内部使用的模块 id，
   * 例如真实文件路径、虚拟模块 id 或插件自定义 id。
   */
  const resolved = module
    ? undefined
    : ((await pluginContainer.resolveId(url, undefined)) ?? undefined) // 🔖断点[小册05] resolveId:把浏览器 url 解析成磁盘真实 id

  const id = module?.id ?? resolved?.id ?? url

  module ??= environment.moduleGraph.getModuleById(id)
  if (module) {
    /**
     * 不同 URL 可能 resolve 到同一个 id。
     * 如果按 id 找到了已存在模块，需要把当前 URL 也关联到这个模块节点，
     * 后续 HMR、缓存和 sourcemap 请求才能通过 URL 找回同一个模块。
     */
    await environment.moduleGraph._ensureEntryFromUrl(url, undefined, resolved)
    // 再尝试复用按 id 命中的模块缓存。
    const cached = await getCachedTransformResult(
      environment,
      url,
      module,
      timestamp,
    )
    if (cached) return cached
  }

  /**
   * 到这里已经确定了模块 id，后面才真正进入 load -> transform 的插件链。
   */
  const result = loadAndTransform(
    environment,
    id,
    url,
    options,
    timestamp,
    module,
    resolved,
  )

  const { depsOptimizer } = environment
  if (!depsOptimizer?.isOptimizedDepFile(id)) {
    /**
     * 普通源码模块要登记为正在处理的请求。
     * 这是按当前 id 单个登记，不是批量登记；依赖 optimizer 会用这些
     * 正在处理的普通源码请求判断首轮静态 import crawl 是否结束。
     * 已经是 optimized dep 文件的请求则不需要反过来参与这个统计。
     */
    environment._registerRequestProcessing(id, () => result) // 🔖断点[小册05] 登记普通模块请求；optimizer 用它等待首轮静态 import crawl 完成
  }

  return result
}

async function getCachedTransformResult(
  environment: DevEnvironment,
  url: string,
  module: EnvironmentModuleNode,
  timestamp: number,
) {
  const prettyUrl = debugCache ? prettifyUrl(url, environment.config.root) : ''

  // tries to handle soft invalidation of the module if available,
  // returns a boolean true is successful, or false if no handling is needed
  const softInvalidatedTransformResult = await handleModuleSoftInvalidation(
    environment,
    module,
    timestamp,
  )
  if (softInvalidatedTransformResult) {
    debugCache?.(`[memory-hmr] ${prettyUrl}`)
    return softInvalidatedTransformResult
  }

  // check if we have a fresh cache
  const cached = module.transformResult
  if (cached) {
    debugCache?.(`[memory] ${prettyUrl}`)
    return cached
  }
}

async function loadAndTransform( // 🔖断点[小册05] load→transform→写缓存的主流程
  environment: DevEnvironment,
  id: string,
  url: string,
  options: TransformOptionsInternal,
  timestamp: number,
  mod?: EnvironmentModuleNode,
  resolved?: PartialResolvedId,
) {
  const { config, pluginContainer, logger } = environment
  const prettyUrl =
    debugLoad || debugTransform ? prettifyUrl(url, config.root) : ''

  const moduleGraph = environment.moduleGraph

  /**
   * 真正读取或转换源码前，先做 transform 场景下的文件访问检查。
   * 虚拟模块以 \0 开头，不走文件系统权限；显式 skipFsCheck 的调用也会绕过。
   */
  if (
    !options.skipFsCheck &&
    id[0] !== '\0' &&
    isServerAccessDeniedForTransform(config, id)
  ) {
    const err: any = new Error(`Denied ID ${id}`)
    err.code = ERR_DENIED_ID
    err.id = id
    throw err
  }

  let code: string | null = null
  let map: SourceDescription['map'] = null
  let moduleType: ModuleType | undefined

  /**
   * load 阶段插件有机会先“虚拟加载”模块；只有没人处理时，才把 id 当作文件路径读磁盘。
   */
  const loadStart = debugLoad ? performance.now() : 0
  const loadResult = await pluginContainer.load(id) // 🔖断点[小册05] load:第一个非空胜出;全 null 则回退 fs.readFile

  if (loadResult == null) {
    const file = cleanUrl(id)

    /**
     * 插件没有 load 结果时，才把 id 当作文件路径读磁盘。
     * 二进制资源通常应该由插件提前处理成字符串；这里也只读取允许访问的文件，
     * 像 /service-worker.js 或 /api/users 这类不属于可加载文件的 URL 会跳过。
     */
    if (
      options.skipFsCheck ||
      isFileLoadingAllowed(environment.getTopLevelConfig(), slash(file))
    ) {
      try {
        code = await fsp.readFile(file, 'utf-8')
        debugLoad?.(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'EISDIR') {
          throw e
        }
      }
      if (code != null && environment.pluginContainer.watcher) {
        ensureWatchedFile(
          environment.pluginContainer.watcher,
          file,
          config.root,
        )
      }
    }
    if (code) {
      /**
       * 源码文件里可能内联或旁挂 sourcemap。
       * 读取磁盘源码后先把这部分 map 提取出来，后面 transform 阶段会继续传递。
       */
      try {
        const extracted = extractSourcemapFromFile(code, file, logger)
        if (extracted) {
          code = extracted.code
          map = extracted.map
        }
      } catch (e) {
        logger.warn(`Failed to load source map for ${file}.\n${e}`, {
          timestamp: true,
        })
      }
    }
  } else {
    /**
     * 插件 load 命中时，插件可以只返回 code 字符串，也可以同时返回 map/moduleType。
     * moduleType 会影响后续 transform 如何理解这个模块内容。
     */
    debugLoad?.(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
      moduleType = loadResult.moduleType
    } else {
      code = loadResult
    }
  }
  if (code == null) {
    /**
     * 到这里仍然没有 code，说明插件和文件系统都没有成功加载该 URL。
     * public 文件给出专门提示：它们应该作为静态资源引用，而不是从源码中 import。
     */
    const isPublicFile = checkPublicFile(url, environment.getTopLevelConfig())
    let publicDirName = path.relative(config.root, config.publicDir)
    if (publicDirName[0] !== '.') publicDirName = '/' + publicDirName
    const msg = isPublicFile
      ? `This file is in ${publicDirName} and will be copied as-is during ` +
        `build without going through the plugin transforms, and therefore ` +
        `should not be imported from source code. It can only be referenced ` +
        `via HTML tags.`
      : `Does the file exist?`
    const importerMod: EnvironmentModuleNode | undefined =
      moduleGraph.idToModuleMap.get(id)?.importers.values().next().value
    const importer = importerMod?.file || importerMod?.url
    const err: any = new Error(
      `Failed to load url ${url} (resolved id: ${id})${
        importer ? ` in ${importer}` : ''
      }. ${msg}`,
    )
    err.code = isPublicFile ? ERR_LOAD_PUBLIC_URL : ERR_LOAD_URL
    throw err
  }
  if (moduleType === undefined) {
    /**
     * 插件没有显式声明 moduleType 时，根据文件扩展名猜测。
     * 只有非 js 类型需要记录，普通 JS 保持默认路径即可。
     */
    const guessedModuleType = getModuleTypeFromId(id)
    if (guessedModuleType && guessedModuleType !== 'js') {
      moduleType = guessedModuleType
    }
  }

  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  /**
   * 只有成功拿到 code 的模块才进图，避免把不存在/被拒绝访问的请求污染模块图。
   * 这一步也会把 url、id 和 resolved 信息关联起来，供缓存、HMR 和 sourcemap 查找使用。
   * 注意这里登记的是“当前请求模块”的节点和索引，还不会扫描 import，也不会建立依赖边；
   * 依赖节点和 importers/importedModules 双向边会在后续 import-analysis 插件中补齐。
   */
  mod ??= await moduleGraph._ensureEntryFromUrl(url, undefined, resolved)

  /**
   * transform 是串行接力：每个插件接收上一个插件的 code，并把 sourcemap 继续往后传。
   */
  const transformStart = debugTransform ? performance.now() : 0
  const transformResult = await pluginContainer.transform(code, id, { // 🔖断点[小册05/06] transform:所有插件依次链式改写 code
    inMap: map,
    moduleType,
  })
  const originalCode = code
  if (transformResult.code === originalCode) {
    // no transform applied, keep code as-is
    debugTransform?.(
      timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`),
    )
  } else {
    debugTransform?.(`${timeFrom(transformStart)} ${prettyUrl}`)
    code = transformResult.code!
    map = transformResult.map
  }

  /**
   * transform 钩子可能返回字符串 map、对象 map 或空 map。
   * 这里统一成后续 send/ssrTransform 能消费的 SourceMap 对象形态。
   */
  let normalizedMap: SourceMap | { mappings: '' } | null
  if (typeof map === 'string') {
    normalizedMap = JSON.parse(map)
  } else if (map) {
    normalizedMap = map as SourceMap | { mappings: '' }
  } else {
    normalizedMap = null
  }

  if (normalizedMap && 'version' in normalizedMap && mod.file) {
    if (normalizedMap.mappings) {
      await injectSourcesContent(normalizedMap, mod.file, logger)
    }

    const sourcemapPath = `${mod.file}.map`
    /**
     * sourcemap 在返回浏览器前会补 sourcesContent、应用 ignoreList，
     * 并把绝对 sources 改成相对路径，避免调试器显示难读的本机绝对路径。
     */
    applySourcemapIgnoreList(
      normalizedMap,
      sourcemapPath,
      config.server.sourcemapIgnoreList,
      logger,
    )

    if (path.isAbsolute(mod.file)) {
      let modDirname
      for (
        let sourcesIndex = 0;
        sourcesIndex < normalizedMap.sources.length;
        ++sourcesIndex
      ) {
        const sourcePath = normalizedMap.sources[sourcesIndex]
        if (sourcePath) {
          // Rewrite sources to relative paths to give debuggers the chance
          // to resolve and display them in a meaningful way (rather than
          // with absolute paths).
          if (path.isAbsolute(sourcePath)) {
            modDirname ??= path.dirname(mod.file)
            normalizedMap.sources[sourcesIndex] = path.relative(
              modDirname,
              sourcePath,
            )
          }
        }
      }
    }
  }

  if (environment._closing && environment.config.dev.recoverable)
    throwClosedServerError()

  const topLevelConfig = environment.getTopLevelConfig()
  /**
   * client 环境直接返回浏览器可执行的 code/map/etag。
   * Module Runner/SSR 环境还要经过 ssrTransform，改写成 runner 能执行和收集依赖的格式。
   */
  const result = environment.config.dev.moduleRunnerTransform
    ? await ssrTransform(code, normalizedMap, url, originalCode, {
        json: {
          stringify:
            topLevelConfig.json.stringify === true &&
            topLevelConfig.json.namedExports !== true,
        },
      })
    : ({
        code,
        map: normalizedMap,
        etag: getEtag(code, { weak: true }),
      } satisfies TransformResult)

  /**
   * 只有模块在本次处理期间没有再次失效，才把结果写入模块图缓存。
   * 如果已经过期，就让下次请求重新走完整转换，避免缓存旧结果。
   */
  if (timestamp > mod.lastInvalidationTimestamp)
    moduleGraph.updateModuleTransformResult(mod, result)

  return result
}

/**
 * When a module is soft-invalidated, we can preserve its previous `transformResult` and
 * return similar code to before:
 *
 * - Client: We need to transform the import specifiers with new timestamps
 * - SSR: We don't need to change anything as `ssrLoadModule` controls it
 */
async function handleModuleSoftInvalidation(
  environment: DevEnvironment,
  mod: EnvironmentModuleNode,
  timestamp: number,
) {
  /**
   * 核心逻辑：软失效保留旧 transformResult，只重写 import URL 上的 ?t= 时间戳。
   * 这样依赖更新时，父模块无需完整重新 load/transform，也能让浏览器请求到新依赖。
   */
  const transformResult = mod.invalidationState

  // Reset invalidation state
  mod.invalidationState = undefined

  // Skip if not soft-invalidated
  if (!transformResult || transformResult === 'HARD_INVALIDATED') return

  if (mod.transformResult) {
    throw new Error(
      `Internal server error: Soft-invalidated module "${mod.url}" should not have existing transform result`,
    )
  }

  let result: TransformResult
  // For SSR soft-invalidation, no transformation is needed
  if (transformResult.ssr) {
    result = transformResult
  }
  // We need to transform each imports with new timestamps if available
  else {
    await init
    const source = transformResult.code
    const s = new MagicString(source)
    const [imports] = parseImports(source, mod.id || undefined)

    for (const imp of imports) {
      let rawUrl = source.slice(imp.s, imp.e)
      if (rawUrl === 'import.meta') continue

      const hasQuotes = rawUrl[0] === '"' || rawUrl[0] === "'"
      if (hasQuotes) {
        rawUrl = rawUrl.slice(1, -1)
      }

      const urlWithoutTimestamp = removeTimestampQuery(rawUrl)
      // hmrUrl must be derived the same way as importAnalysis
      const hmrUrl = unwrapId(
        stripBase(
          removeImportQuery(urlWithoutTimestamp),
          environment.config.base,
        ),
      )
      for (const importedMod of mod.importedModules) {
        if (importedMod.url !== hmrUrl) continue
        if (importedMod.lastHMRTimestamp > 0) {
          const replacedUrl = injectQuery(
            urlWithoutTimestamp,
            `t=${importedMod.lastHMRTimestamp}`,
          )
          const start = hasQuotes ? imp.s + 1 : imp.s
          const end = hasQuotes ? imp.e - 1 : imp.e
          s.overwrite(start, end, replacedUrl)
        }

        if (imp.d === -1 && environment.config.dev.preTransformRequests) {
          // pre-transform known direct imports
          environment.warmupRequest(hmrUrl)
        }

        break
      }
    }

    // Update `transformResult` with new code. We don't have to update the sourcemap
    // as the timestamp changes doesn't affect the code lines (stable).
    const code = s.toString()
    result = {
      ...transformResult,
      code,
      etag: getEtag(code, { weak: true }),
    }
  }

  // Only cache the result if the module wasn't invalidated while it was
  // being processed, so it is re-processed next time if it is stale
  if (timestamp > mod.lastInvalidationTimestamp)
    environment.moduleGraph.updateModuleTransformResult(mod, result)

  return result
}

// https://github.com/rolldown/rolldown/blob/cc66f4b7189dfb3a248608d02f5962edb09b11f8/crates/rolldown/src/utils/normalize_options.rs#L95-L111
const defaultModuleTypes: Record<string, ModuleType | undefined> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  json: 'json',
  txt: 'text',
  css: 'css',
}

// https://github.com/rolldown/rolldown/blob/bf53a100edf1780d5a5aa41f0bc0459c5696543e/crates/rolldown/src/utils/load_source.rs#L53-L89
export function getModuleTypeFromId(id: string): ModuleType | undefined {
  let pos = -1
  while ((pos = id.indexOf('.', pos + 1)) >= 0) {
    const ext = id.slice(pos + 1)
    const moduleType = defaultModuleTypes[ext]
    if (moduleType) {
      return moduleType
    }
  }
}
