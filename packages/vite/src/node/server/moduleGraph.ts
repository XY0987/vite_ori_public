import { extname } from 'node:path'
import type { ModuleInfo, PartialResolvedId } from 'rolldown'
import { isDirectCSSRequest } from '../plugins/css'
import {
  monotonicDateNow,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery,
} from '../utils'
import { FS_PREFIX } from '../constants'
import { cleanUrl } from '../../shared/utils'
import type { TransformResult } from './transformRequest'

export class EnvironmentModuleNode {
  environment: string
  /**
   * Public served url path, starts with /
   */
  url: string
  /**
   * Resolved file system path + query
   */
  id: string | null = null
  file: string | null = null
  type: 'js' | 'css' | 'asset'
  info?: ModuleInfo
  meta?: Record<string, any>
  importers: Set<EnvironmentModuleNode> = new Set()

  importedModules: Set<EnvironmentModuleNode> = new Set()

  acceptedHmrDeps: Set<EnvironmentModuleNode> = new Set()
  acceptedHmrExports: Set<string> | null = null
  importedBindings: Map<string, Set<string>> | null = null
  isSelfAccepting?: boolean
  transformResult: TransformResult | null = null

  // ssrModule and ssrError are no longer needed. They are on the module runner module cache.
  // Once `ssrLoadModule` is re-implemented on top of the new APIs, we can delete these.
  ssrModule: Record<string, any> | null = null
  ssrError: Error | null = null

  lastHMRTimestamp = 0
  /**
   * `import.meta.hot.invalidate` is called by the client.
   * If there's multiple clients, multiple `invalidate` request is received.
   * This property is used to dedupe those request to avoid multiple updates happening.
   * @internal
   */
  lastHMRInvalidationReceived = false
  lastInvalidationTimestamp = 0
  /**
   * If the module only needs to update its imports timestamp (e.g. within an HMR chain),
   * it is considered soft-invalidated. In this state, its `transformResult` should exist,
   * and the next `transformRequest` for this module will replace the timestamps.
   *
   * By default the value is `undefined` if it's not soft/hard-invalidated. If it gets
   * soft-invalidated, this will contain the previous `transformResult` value. If it gets
   * hard-invalidated, this will be set to `'HARD_INVALIDATED'`.
   * @internal
   */
  invalidationState: TransformResult | 'HARD_INVALIDATED' | undefined
  /**
   * The module urls that are statically imported in the code. This information is separated
   * out from `importedModules` as only importers that statically import the module can be
   * soft invalidated. Other imports (e.g. watched files) needs the importer to be hard invalidated.
   * @internal
   */
  staticImportedUrls?: Set<string>

  /**
   * @param setIsSelfAccepting - set `false` to set `isSelfAccepting` later. e.g. #7870
   */
  constructor(url: string, environment: string, setIsSelfAccepting = true) {
    this.environment = environment
    this.url = url
    this.type = isDirectCSSRequest(url) ? 'css' : 'js'
    if (setIsSelfAccepting) {
      this.isSelfAccepting = false
    }
  }
}

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined,
]

export class EnvironmentModuleGraph {
  environment: string

  urlToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  idToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  etagToModuleMap: Map<string, EnvironmentModuleNode> = new Map()
  // a single file may corresponds to multiple modules with different queries
  fileToModulesMap: Map<string, Set<EnvironmentModuleNode>> = new Map()

  /**
   * @internal
   */
  _unresolvedUrlToModuleMap: Map<
    string,
    EnvironmentModuleNode | Promise<EnvironmentModuleNode>
  > = new Map()

  /**
   * @internal
   */
  _resolveId: (url: string) => Promise<PartialResolvedId | null>

  /** @internal */
  _hasResolveFailedErrorModules: Set<EnvironmentModuleNode> = new Set()

  constructor(
    environment: string,
    resolveId: (url: string) => Promise<PartialResolvedId | null>,
  ) {
    this.environment = environment
    this._resolveId = resolveId
  }

  async getModuleByUrl(
    rawUrl: string,
  ): Promise<EnvironmentModuleNode | undefined> {
    // Quick path, if we already have a module for this rawUrl (even without extension)
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    const mod = this._getUnresolvedUrlToModule(rawUrl)
    if (mod) {
      return mod
    }

    const [url] = await this._resolveUrl(rawUrl)
    return this.urlToModuleMap.get(url)
  }

  getModuleById(id: string): EnvironmentModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  getModulesByFile(file: string): Set<EnvironmentModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      const seen = new Set<EnvironmentModuleNode>()
      mods.forEach((mod) => {
        this.invalidateModule(mod, seen)
      })
    }
  }

  onFileDelete(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      mods.forEach((mod) => {
        mod.importedModules.forEach((importedMod) => {
          importedMod.importers.delete(mod)
        })
      })
    }
  }

  /**
   * HMR 进入这里后会清空当前模块的 transform/etag/SSR 缓存。
   * 硬失效表示下次请求必须重新 transform；软失效会保留旧 transformResult，
   * 让 transformRequest 只更新时间戳，避免静态 importer 做不必要的完整重编译。
   */
  invalidateModule( // 🔖断点[小册09] 失效模块:清 transformResult/etag,按软/硬失效向 importers 级联
    mod: EnvironmentModuleNode,
    seen: Set<EnvironmentModuleNode> = new Set(),
    timestamp: number = monotonicDateNow(),
    isHmr: boolean = false,
    /** @internal */
    softInvalidate = false,
  ): void {
    const prevInvalidationState = mod.invalidationState

    // Handle soft invalidation before the `seen` check, as consecutive soft/hard invalidations can
    // cause the final soft invalidation state to be different.
    // If soft invalidated, save the previous `transformResult` so that we can reuse and transform the
    // import timestamps only in `transformRequest`. If there's no previous `transformResult`, hard invalidate it.
    if (softInvalidate) {
      mod.invalidationState ??= mod.transformResult ?? 'HARD_INVALIDATED'
    }
    // If hard invalidated, further soft invalidations have no effect until it's reset to `undefined`
    else {
      mod.invalidationState = 'HARD_INVALIDATED'
    }

    // Skip updating the module if it was already invalidated before and the invalidation state has not changed
    if (seen.has(mod) && prevInvalidationState === mod.invalidationState) {
      return
    }
    seen.add(mod)

    if (isHmr) {
      mod.lastHMRTimestamp = timestamp
      mod.lastHMRInvalidationReceived = false
    } else {
      // Save the timestamp for this invalidation, so we can avoid caching the result of possible already started
      // processing being done for this module
      mod.lastInvalidationTimestamp = timestamp
    }

    // Don't invalidate mod.info and mod.meta, as they are part of the processing pipeline
    // Invalidating the transform result is enough to ensure this module is re-processed next time it is requested
    const etag = mod.transformResult?.etag
    if (etag) this.etagToModuleMap.delete(etag)

    mod.transformResult = null

    mod.ssrModule = null
    mod.ssrError = null

    mod.importers.forEach((importer) => {
      if (!importer.acceptedHmrDeps.has(mod)) {
        // If the importer statically imports the current module, we can soft-invalidate the importer
        // to only update the import timestamps. If it's not statically imported, e.g. watched/glob file,
        // we can only soft invalidate if the current module was also soft-invalidated. A soft-invalidation
        // doesn't need to trigger a re-load and re-transform of the importer.
        // But we exclude direct CSS files as those cannot be soft invalidated.
        const shouldSoftInvalidateImporter =
          (importer.staticImportedUrls?.has(mod.url) || softInvalidate) &&
          importer.type === 'js'
        this.invalidateModule(
          importer,
          seen,
          timestamp,
          isHmr,
          shouldSoftInvalidateImporter,
        )
      }
    })

    this._hasResolveFailedErrorModules.delete(mod)
  }

  invalidateAll(): void {
    const timestamp = monotonicDateNow()
    const seen = new Set<EnvironmentModuleNode>()
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen, timestamp)
    })
  }

  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   *
   * @param staticImportedUrls Subset of `importedModules` where they're statically imported in code.
   *   This is only used for soft invalidations so `undefined` is fine but may cause more runtime processing.
   */
  async updateModuleInfo( // 🔖断点[小册09] 连边:建立 importers/importedModules 双向边 + HMR 接受关系
    mod: EnvironmentModuleNode,
    importedModules: Set<string | EnvironmentModuleNode>,
    importedBindings: Map<string, Set<string>> | null,
    acceptedModules: Set<string | EnvironmentModuleNode>,
    acceptedExports: Set<string> | null,
    isSelfAccepting: boolean,
    /** @internal */
    staticImportedUrls?: Set<string>,
  ): Promise<Set<EnvironmentModuleNode> | undefined> {
    mod.isSelfAccepting = isSelfAccepting
    const prevImports = mod.importedModules
    let noLongerImported: Set<EnvironmentModuleNode> | undefined

    /**
     * 核心逻辑：模块图的边是双向维护的。
     * 当前模块记录 importedModules；被依赖模块也要反向记录 importers，HMR 才能向上传播。
     */
    let resolvePromises = []
    let resolveResults = new Array(importedModules.size)
    let index = 0
    // update import graph
    for (const imported of importedModules) {
      const nextIndex = index++
      if (typeof imported === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(imported).then((dep) => {
            dep.importers.add(mod)
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        imported.importers.add(mod)
        resolveResults[nextIndex] = imported
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    const nextImports = new Set(resolveResults)
    mod.importedModules = nextImports

    /**
     * remove the importer from deps that were imported but no longer are.
     * transform 后 import 列表可能变化，旧边必须删掉，否则 HMR 会沿过期依赖误传播。
     */
    prevImports.forEach((dep) => {
      if (!mod.importedModules.has(dep)) {
        dep.importers.delete(mod)
        if (!dep.importers.size) {
          // dependency no longer imported
          ;(noLongerImported || (noLongerImported = new Set())).add(dep)
        }
      }
    })

    /**
     * update accepted hmr deps
     * acceptedHmrDeps 是 propagateUpdate 判断边界的依据，和普通 import 边分开记录。
     */
    resolvePromises = []
    resolveResults = new Array(acceptedModules.size)
    index = 0
    for (const accepted of acceptedModules) {
      const nextIndex = index++
      if (typeof accepted === 'string') {
        resolvePromises.push(
          this.ensureEntryFromUrl(accepted).then((dep) => {
            resolveResults[nextIndex] = dep
          }),
        )
      } else {
        resolveResults[nextIndex] = accepted
      }
    }

    if (resolvePromises.length) {
      await Promise.all(resolvePromises)
    }

    mod.acceptedHmrDeps = new Set(resolveResults)
    mod.staticImportedUrls = staticImportedUrls

    // update accepted hmr exports
    mod.acceptedHmrExports = acceptedExports
    mod.importedBindings = importedBindings
    return noLongerImported
  }

  async ensureEntryFromUrl(
    rawUrl: string,
    setIsSelfAccepting = true,
  ): Promise<EnvironmentModuleNode> {
    return this._ensureEntryFromUrl(rawUrl, setIsSelfAccepting)
  }

  /**
   * @internal
   *
   * 确保 rawUrl 在模块图里有一个 EnvironmentModuleNode。
   * 这个函数不等于“永远创建新节点”：如果 URL 或 resolvedId 已经命中过旧节点，
   * 会直接复用；只有首次遇到该模块时，才会创建节点并登记 url/id/file 三类索引。
   * 它只负责节点身份和索引，不负责维护 importers/importedModules 依赖边。
   */
  async _ensureEntryFromUrl( // 🔖断点[小册09] 进图:resolve url→id,新建节点并登记进 url/id/file 三张表
    rawUrl: string,
    setIsSelfAccepting = true,
    // Optimization, avoid resolving the same url twice if the caller already did it
    resolved?: PartialResolvedId,
  ): Promise<EnvironmentModuleNode> {
    /**
     * 先走 unresolvedUrlToModuleMap 快路径。
     * 同一个浏览器 URL 可能在短时间内被多处请求，命中这里可以直接复用节点或复用正在创建中的 Promise。
     */
    rawUrl = removeImportQuery(removeTimestampQuery(rawUrl))
    let mod = this._getUnresolvedUrlToModule(rawUrl)
    if (mod) {
      return mod
    }
    const modPromise = (async () => {
      const [url, resolvedId, meta] = await this._resolveUrl(rawUrl, resolved)
      mod = this.idToModuleMap.get(resolvedId)
      if (!mod) {
        /**
         * resolvedId 没有命中旧节点时，才真正创建 EnvironmentModuleNode。
         * 创建后同时登记三张核心索引：
         * urlToModuleMap 解决“请求 URL 找节点”，idToModuleMap 解决“resolved id 找节点”，
         * fileToModulesMap 解决“文件变更时找到所有关联模块”。
         */
        mod = new EnvironmentModuleNode(
          url,
          this.environment,
          setIsSelfAccepting,
        )
        if (meta) mod.meta = meta
        this.urlToModuleMap.set(url, mod)
        mod.id = resolvedId
        this.idToModuleMap.set(resolvedId, mod)
        const file = (mod.file = cleanUrl(resolvedId))
        let fileMappedModules = this.fileToModulesMap.get(file)
        if (!fileMappedModules) {
          fileMappedModules = new Set()
          this.fileToModulesMap.set(file, fileMappedModules)
        }
        fileMappedModules.add(mod)
      }
      /**
       * 多个 URL 可能 resolve 到同一个 resolvedId，例如带不同 query 的请求。
       * 这时不创建新节点，只把新的 URL 补登记到已有节点上。
       */
      else if (!this.urlToModuleMap.has(url)) {
        this.urlToModuleMap.set(url, mod)
      }
      this._setUnresolvedUrlToModule(rawUrl, mod)
      return mod
    })()

    /**
     * 先把正在创建中的 Promise 放进 rawUrl 缓存。
     * 后续相同 URL 进来时可以直接 await 同一个 Promise，避免重复 resolve 和重复建节点。
     */
    this._setUnresolvedUrlToModule(rawUrl, modPromise)
    return modPromise
  }

  // some deps, like a css file referenced via @import, don't have its own
  // url because they are inlined into the main css import. But they still
  // need to be represented in the module graph so that they can trigger
  // hmr in the importing css file.
  createFileOnlyEntry(file: string): EnvironmentModuleNode {
    file = normalizePath(file)
    let fileMappedModules = this.fileToModulesMap.get(file)
    if (!fileMappedModules) {
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    const url = `${FS_PREFIX}${file}`
    for (const m of fileMappedModules) {
      if ((m.url === url || m.id === file) && m.type === 'asset') {
        return m
      }
    }

    const mod = new EnvironmentModuleNode(url, this.environment)
    mod.type = 'asset'
    mod.file = file
    fileMappedModules.add(mod)
    return mod
  }

  // for incoming urls, it is important to:
  // 1. remove the HMR timestamp query (?t=xxxx) and the ?import query
  // 2. resolve its extension so that urls with or without extension all map to
  // the same module
  async resolveUrl(url: string): Promise<ResolvedUrl> {
    url = removeImportQuery(removeTimestampQuery(url))
    const mod = await this._getUnresolvedUrlToModule(url)
    if (mod?.id) {
      return [mod.url, mod.id, mod.meta]
    }
    return this._resolveUrl(url)
  }

  /**
   * 写入模块转换缓存。
   * transformResult 每个环境都需要保存，供下一次 transformRequest / module runner 复用；
   * etagToModuleMap 只服务浏览器 HTTP 条件请求，所以只在 client 环境维护。
   * SSR / custom environment 不通过 If-None-Match 反查模块，保存 transformResult 就够了。
   */
  updateModuleTransformResult( // 🔖断点[小册09] 写环境转换缓存；只有 client 环境同步维护 ETag 反向索引
    mod: EnvironmentModuleNode,
    result: TransformResult | null,
  ): void {
    if (this.environment === 'client') {
      const prevEtag = mod.transformResult?.etag
      if (prevEtag) this.etagToModuleMap.delete(prevEtag)
      if (result?.etag) this.etagToModuleMap.set(result.etag, mod)
    }

    mod.transformResult = result
  }

  getModuleByEtag(etag: string): EnvironmentModuleNode | undefined {
    return this.etagToModuleMap.get(etag)
  }

  /**
   * @internal
   */
  _getUnresolvedUrlToModule(
    url: string,
  ): Promise<EnvironmentModuleNode> | EnvironmentModuleNode | undefined {
    return this._unresolvedUrlToModuleMap.get(url)
  }
  /**
   * @internal
   */
  _setUnresolvedUrlToModule(
    url: string,
    mod: Promise<EnvironmentModuleNode> | EnvironmentModuleNode,
  ): void {
    this._unresolvedUrlToModuleMap.set(url, mod)
  }

  /**
   * @internal
   */
  async _resolveUrl(
    url: string,
    alreadyResolved?: PartialResolvedId,
  ): Promise<ResolvedUrl> {
    const resolved = alreadyResolved ?? (await this._resolveId(url))
    const resolvedId = resolved?.id || url
    if (
      url !== resolvedId &&
      !url.includes('\0') &&
      !url.startsWith(`virtual:`)
    ) {
      const ext = extname(cleanUrl(resolvedId))
      if (ext) {
        const pathname = cleanUrl(url)
        if (!pathname.endsWith(ext)) {
          url = pathname + ext + url.slice(pathname.length)
        }
      }
    }
    return [url, resolvedId, resolved?.meta]
  }
}
