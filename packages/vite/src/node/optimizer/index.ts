import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { ignoreInput, ignoreOutput } from '@voidzero-dev/vite-task-client'
import colors from 'picocolors'
import { init, parse } from 'es-module-lexer'
import { isDynamicPattern } from 'tinyglobby'
import {
  type RolldownOptions,
  type RolldownOutput,
  type OutputOptions as RolldownOutputOptions,
  rolldown,
} from 'rolldown'
import type { DepsOptimizerEsbuildOptions } from '#types/internal/esbuildOptions'
import type { ResolvedConfig } from '../config'
import {
  arraify,
  asyncFlatten,
  createDebugger,
  flattenId,
  getHash,
  isOptimizable,
  lookupFile,
  normalizeId,
  normalizePath,
  removeLeadingSlash,
  tryStatSync,
  unique,
} from '../utils'
import {
  ESBUILD_BASELINE_WIDELY_AVAILABLE_TARGET,
  METADATA_FILENAME,
} from '../constants'
import { isWindows } from '../../shared/utils'
import type { Environment } from '../environment'
import { transformWithOxc } from '../plugins/oxc'
import { ScanEnvironment, scanImports } from './scan'
import { createOptimizeDepsIncludeResolver, expandGlobIds } from './resolve'
import {
  rolldownCjsExternalPlugin,
  rolldownDepPlugin,
} from './rolldownDepPlugin'

const debug = createDebugger('vite:deps')

const jsExtensionRE = /\.js$/i

export type ExportsData = {
  hasModuleSyntax: boolean
  // exported names (for `export { a as b }`, `b` is exported name)
  exports: readonly string[]
  // hint if the dep requires loading as jsx
  jsxLoader?: boolean
}

export interface DepsOptimizer {
  init: () => Promise<void>

  metadata: DepOptimizationMetadata
  scanProcessing?: Promise<void>
  registerMissingImport: (id: string, resolved: string) => OptimizedDepInfo
  run: () => void

  isOptimizedDepFile: (id: string) => boolean
  isOptimizedDepUrl: (url: string) => boolean
  getOptimizedDepId: (depInfo: OptimizedDepInfo) => string

  close: () => Promise<void>

  options: DepOptimizationOptions
}

export interface DepOptimizationConfig {
  /**
   * Force optimize listed dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  include?: string[]
  /**
   * Do not optimize these dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  exclude?: string[]
  /**
   * Forces ESM interop when importing these dependencies. Some legacy
   * packages advertise themselves as ESM but use `require` internally
   * @experimental
   */
  needsInterop?: string[]
  /**
   * Options to pass to esbuild during the dep scanning and optimization
   *
   * Certain options are omitted since changing them would not be compatible
   * with Vite's dep optimization.
   *
   * - `external` is also omitted, use Vite's `optimizeDeps.exclude` option
   * - `plugins` are merged with Vite's dep plugin
   *
   * https://esbuild.github.io/api
   *
   * @deprecated Use `rolldownOptions` instead.
   */
  esbuildOptions?: DepsOptimizerEsbuildOptions
  /**
   * @deprecated Use `rolldownOptions` instead.
   */
  rollupOptions?: Omit<RolldownOptions, 'input' | 'logLevel' | 'output'> & {
    output?: Omit<
      RolldownOutputOptions,
      'format' | 'sourcemap' | 'dir' | 'banner'
    >
  }
  /**
   * Options to pass to rolldown during the dep scanning and optimization
   *
   * Certain options are omitted since changing them would not be compatible
   * with Vite's dep optimization.
   *
   * - `plugins` are merged with Vite's dep plugin
   */
  rolldownOptions?: Omit<RolldownOptions, 'input' | 'logLevel' | 'output'> & {
    output?: Omit<
      RolldownOutputOptions,
      'format' | 'sourcemap' | 'dir' | 'banner'
    >
  }
  /**
   * List of file extensions that can be optimized. A corresponding esbuild
   * plugin must exist to handle the specific extension.
   *
   * By default, Vite can optimize `.mjs`, `.js`, `.ts`, and `.mts` files. This option
   * allows specifying additional extensions.
   *
   * @experimental
   */
  extensions?: string[]
  /**
   * Deps optimization during build was removed in Vite 5.1. This option is
   * now redundant and will be removed in a future version. Switch to using
   * `optimizeDeps.noDiscovery` and an empty or undefined `optimizeDeps.include`.
   * true or 'dev' disables the optimizer, false or 'build' leaves it enabled.
   * @default 'build'
   * @deprecated
   * @experimental
   */
  disabled?: boolean | 'build' | 'dev'
  /**
   * Automatic dependency discovery. When `noDiscovery` is true, only dependencies
   * listed in `include` will be optimized. The scanner isn't run for cold start
   * in this case. CJS-only dependencies must be present in `include` during dev.
   * @default false
   */
  noDiscovery?: boolean
  /**
   * When enabled, it will hold the first optimized deps results until all static
   * imports are crawled on cold start. This avoids the need for full-page reloads
   * when new dependencies are discovered and they trigger the generation of new
   * common chunks. If all dependencies are found by the scanner plus the explicitly
   * defined ones in `include`, it is better to disable this option to let the
   * browser process more requests in parallel.
   * @default true
   * @experimental
   */
  holdUntilCrawlEnd?: boolean
  /**
   * When enabled, Vite will not throw an error when an outdated optimized
   * dependency is requested. Enabling this option may cause a single module
   * to have a multiple reference.
   * @default false
   * @experimental
   */
  ignoreOutdatedRequests?: boolean
}

export type DepOptimizationOptions = DepOptimizationConfig & {
  /**
   * By default, Vite will crawl your `index.html` to detect dependencies that
   * need to be pre-bundled. If `build.rolldownOptions.input` is specified, Vite
   * will crawl those entry points instead.
   *
   * If neither of these fit your needs, you can specify custom entries using
   * this option - the value should be a tinyglobby pattern or array of patterns
   * (https://github.com/SuperchupuDev/tinyglobby) that are relative from
   * vite project root. This will overwrite default entries inference.
   */
  entries?: string | string[]
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   * @experimental
   */
  force?: boolean
}

export function isDepOptimizationDisabled(
  optimizeDeps: DepOptimizationOptions,
): boolean {
  return (
    optimizeDeps.disabled === true ||
    optimizeDeps.disabled === 'dev' ||
    (!!optimizeDeps.noDiscovery && !optimizeDeps.include?.length)
  )
}

export interface DepOptimizationResult {
  metadata: DepOptimizationMetadata
  /**
   * When doing a re-run, if there are newly discovered dependencies
   * the page reload will be delayed until the next rerun so we need
   * to be able to discard the result
   */
  commit: () => Promise<void>
  cancel: () => void
}

export interface OptimizedDepInfo {
  id: string
  file: string
  src?: string
  needsInterop?: boolean
  browserHash?: string
  fileHash?: string
  /**
   * During optimization, ids can still be resolved to their final location
   * but the bundles may not yet be saved to disk
   */
  processing?: Promise<void>
  /**
   * ExportData cache, discovered deps will parse the src entry to get exports
   * data used both to define if interop is needed and when pre-bundling
   */
  exportsData?: Promise<ExportsData>
  isDynamicEntry?: boolean
}

export interface DepOptimizationMetadata {
  /**
   * The main hash is determined by user config and dependency lockfiles.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  hash: string
  /**
   * This hash is determined by dependency lockfiles.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  lockfileHash: string
  /**
   * This hash is determined by user config.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  configHash: string
  /**
   * The browser hash is determined by the main hash plus additional dependencies
   * discovered at runtime. This is used to invalidate browser requests to
   * optimized deps.
   */
  browserHash: string
  /**
   * Metadata for each already optimized dependency
   */
  optimized: Record<string, OptimizedDepInfo>
  /**
   * Metadata for non-entry optimized chunks and dynamic imports
   */
  chunks: Record<string, OptimizedDepInfo>
  /**
   * Metadata for each newly discovered dependency after processing
   */
  discovered: Record<string, OptimizedDepInfo>
  /**
   * OptimizedDepInfo list
   */
  depInfoList: OptimizedDepInfo[]
}

/**
 * Scan and optimize dependencies within a project.
 * Used by Vite CLI when running `vite optimize`.
 *
 * @deprecated the optimization process runs automatically and does not need to be called
 */

export async function optimizeDeps(
  config: ResolvedConfig,
  force: boolean | undefined = config.optimizeDeps.force,
  asCommand = false,
): Promise<DepOptimizationMetadata> {
  const log = asCommand ? config.logger.info : debug

  config.logger.warn(
    colors.yellow(
      'manually calling optimizeDeps is deprecated. This is done automatically and does not need to be called manually.',
    ),
  )

  const environment = new ScanEnvironment('client', config)
  await environment.init()

  const cachedMetadata = await loadCachedDepOptimizationMetadata(
    environment,
    force,
    asCommand,
  )
  if (cachedMetadata) {
    return cachedMetadata
  }

  const deps = await discoverProjectDependencies(environment).result

  await addManuallyIncludedOptimizeDeps(environment, deps)

  const depsString = depsLogString(Object.keys(deps))
  log?.(colors.green(`Optimizing dependencies:\n  ${depsString}`))

  const depsInfo = toDiscoveredDependencies(environment, deps)

  const result = await runOptimizeDeps(environment, depsInfo).result

  await result.commit()

  return result.metadata
}

export async function optimizeExplicitEnvironmentDeps(
  environment: Environment,
): Promise<DepOptimizationMetadata> {
  /**
   * 显式依赖优化入口：用于 optimizeDeps.noDiscovery=true 的环境。
   *
   * 该模式不会扫描业务源码来自动发现依赖，只处理当前 environment 的
   * optimizeDeps.include。environment 决定本次运行使用的配置、缓存目录和哈希，
   * 所以 client、ssr 或自定义环境会各自得到独立的预构建 metadata/产物。
   *
   * 流程：尝试环境缓存 -> 收集 include -> Rolldown 预构建 -> commit -> 返回 metadata。
   */
  const cachedMetadata = await loadCachedDepOptimizationMetadata(
    environment,
    environment.config.optimizeDeps.force ?? false,
    false,
  )
  if (cachedMetadata) {
    // 当前环境的 lockfile/config 哈希未变，直接复用已有预构建结果。
    return cachedMetadata
  }

  const deps: Record<string, string> = {}

  // noDiscovery 模式只从 optimizeDeps.include 展开并解析入口，不做源码扫描。
  await addManuallyIncludedOptimizeDeps(environment, deps)

  // 把 { 依赖名: 入口文件 } 转成带 file/browserHash/processing 的内部描述。
  const depsInfo = toDiscoveredDependencies(environment, deps)

  // 启动一次可取消的 Rolldown 预构建，并等待本轮输出准备完成。
  const result = await runOptimizeDeps(environment, depsInfo).result

  // 将临时目录和 _metadata.json 提交为该环境的正式 deps 缓存。
  await result.commit()

  return result.metadata
}

export function initDepsOptimizerMetadata(
  environment: Environment,
  timestamp?: string,
): DepOptimizationMetadata {
  const { lockfileHash, configHash, hash } = getDepHash(environment)
  return {
    hash,
    lockfileHash,
    configHash,
    browserHash: getOptimizedBrowserHash(hash, {}, timestamp),
    optimized: {},
    chunks: {},
    discovered: {},
    depInfoList: [],
  }
}

export function addOptimizedDepInfo(
  metadata: DepOptimizationMetadata,
  type: 'optimized' | 'discovered' | 'chunks',
  depInfo: OptimizedDepInfo,
): OptimizedDepInfo {
  metadata[type][depInfo.id] = depInfo
  metadata.depInfoList.push(depInfo)
  return depInfo
}

let firstLoadCachedDepOptimizationMetadata = true

/**
 * Creates the initial dep optimization metadata, loading it from the deps cache
 * if it exists and pre-bundling isn't forced
 */
export async function loadCachedDepOptimizationMetadata(
  environment: Environment,
  force: boolean = environment.config.optimizeDeps.force ?? false,
  asCommand = false,
): Promise<DepOptimizationMetadata | undefined> {
  const log = asCommand ? environment.logger.info : debug

  if (firstLoadCachedDepOptimizationMetadata) {
    firstLoadCachedDepOptimizationMetadata = false
    // Fire up a clean up of stale processing deps dirs if older process exited early
    setTimeout(
      () => cleanupDepsCacheStaleDirs(environment.getTopLevelConfig()),
      0,
    ).unref()
  }

  const depsCacheDir = getDepsCacheDir(environment)

  // When run inside Vite Task, the dep optimizer cache is both read and
  // written under this directory (metadata + pre-bundled deps). Tell Vite
  // Task to treat it as neither a build input nor a build output: the
  // lockfile hash stored in the metadata already drives re-optimization,
  // and the cache is process-local scratch space, not a build artifact.
  ignoreInput(depsCacheDir)
  ignoreOutput(depsCacheDir)

  /**
   * 核心逻辑：依赖预构建缓存是否可复用，只看 metadata 里的 lockfileHash/configHash。
   * 只要锁文件或影响预构建的配置变了，就丢弃旧 cacheDir，重新生成依赖产物。
   */
  if (!force) {
    let cachedMetadata: DepOptimizationMetadata | undefined
    try {
      const cachedMetadataPath = path.join(depsCacheDir, METADATA_FILENAME)
      cachedMetadata = parseDepsOptimizerMetadata(
        await fsp.readFile(cachedMetadataPath, 'utf-8'),
        depsCacheDir,
      )
    } catch {}
    // hash is consistent, no need to re-bundle
    if (cachedMetadata) {
      if (cachedMetadata.lockfileHash !== getLockfileHash(environment)) { // 🔖断点[小册04] 缓存失效判定:对比锁文件/配置哈希,解释"为什么这次重新预构建"
        environment.logger.info(
          'Re-optimizing dependencies because lockfile has changed',
          {
            timestamp: true,
          },
        )
      } else if (cachedMetadata.configHash !== getConfigHash(environment)) {
        environment.logger.info(
          'Re-optimizing dependencies because vite config has changed',
          {
            timestamp: true,
          },
        )
      } else {
        log?.(
          `(${environment.name}) Hash is consistent. Skipping. Use --force to override.`,
        )
        // Nothing to commit or cancel as we are using the cache, we only
        // need to resolve the processing promise so requests can move on
        return cachedMetadata
      }
    }
  } else {
    environment.logger.info('Forced re-optimization of dependencies', {
      timestamp: true,
    })
  }

  // Start with a fresh cache
  debug?.(
    `(${environment.name}) ${colors.green(`removing old cache dir ${depsCacheDir}`)}`,
  )
  await fsp.rm(depsCacheDir, { recursive: true, force: true })
}

/**
 * Initial optimizeDeps at server start. Perform a fast scan using esbuild to
 * find deps to pre-bundle and include user hard-coded dependencies
 */
export function discoverProjectDependencies(environment: ScanEnvironment): {
  cancel: () => Promise<void>
  result: Promise<Record<string, string>>
} {
  const { cancel, result } = scanImports(environment)

  return {
    cancel,
    result: result.then(({ deps, missing }) => {
      const missingIds = Object.keys(missing)
      if (missingIds.length) {
        throw new Error(
          `The following dependencies are imported but could not be resolved:\n\n  ${missingIds
            .map(
              (id) =>
                `${colors.cyan(id)} ${colors.white(
                  colors.dim(`(imported by ${missing[id]})`),
                )}`,
            )
            .join(`\n  `)}\n\nAre they installed?`,
        )
      }

      return deps
    }),
  }
}

export function toDiscoveredDependencies(
  environment: Environment,
  deps: Record<string, string>,
  timestamp?: string,
): Record<string, OptimizedDepInfo> {
  const browserHash = getOptimizedBrowserHash(
    getDepHash(environment).hash,
    deps,
    timestamp,
  )
  const discovered: Record<string, OptimizedDepInfo> = {}
  for (const id in deps) {
    const src = deps[id]
    discovered[id] = {
      id,
      file: getOptimizedDepPath(environment, id),
      src,
      browserHash: browserHash,
      exportsData: extractExportsData(environment, src),
    }
  }
  return discovered
}

export function depsLogString(qualifiedIds: string[]): string {
  return colors.yellow(qualifiedIds.join(`, `))
}

/**
 * 依赖预构建的核心执行函数：为某个 environment 准备并启动一次 Rolldown 优化任务。
 *
 * 输入 depsInfo 是本轮要处理的依赖入口；返回值刻意拆成：
 * - cancel：取消 Rolldown context，并清理本轮临时目录；
 * - result：异步产出 DepOptimizationResult，其中包含新 metadata、commit 和 cancel。
 *
 * runOptimizeDeps 只负责“生成候选结果”，不会自动替换正式缓存。上层状态机需要根据
 * crawl 结果、interop/hash 是否变化等条件决定 commit 还是 cancel。这样冷启动扫描结果
 * 可以先在后台生成，又不会在确认可用前破坏当前正在服务的旧缓存。
 */
export function runOptimizeDeps(
  environment: Environment,
  depsInfo: Record<string, OptimizedDepInfo>,
): {
  cancel: () => Promise<void>
  result: Promise<DepOptimizationResult>
} {
  // 所有异步阶段共享取消标记，避免取消后仍把 Rolldown 输出当作成功结果提交。
  const optimizerContext = { cancelled: false }

  // 正式目录按 environment 隔离；processing 目录是本轮运行独有的临时目录。
  const depsCacheDir = getDepsCacheDir(environment)
  const processingCacheDir = getProcessingDepsCacheDir(environment)

  /**
   * 所有新产物先写 processing 临时目录。
   * 打包失败或被取消时只删临时目录，当前正式缓存仍可继续服务；
   * commit 时再通过 rename 尽可能原子地替换正式目录。
   */
  fs.mkdirSync(processingCacheDir, { recursive: true })

  // 标记预构建目录为 ESM，使 Node 和后续工具按 ES module 解释生成文件。
  debug?.(colors.green(`creating package.json in ${processingCacheDir}`))
  fs.writeFileSync(
    path.resolve(processingCacheDir, 'package.json'),
    `{\n  "type": "module"\n}\n`,
  )

  // 为当前环境创建本轮 metadata，初始包含 lockfile/config/hash 等缓存身份。
  const metadata = initDepsOptimizerMetadata(environment)

  // browserHash 还要包含本轮依赖集合，供浏览器 URL 版本校验和失效判断。
  metadata.browserHash = getOptimizedBrowserHash(
    metadata.hash,
    depsFromOptimizedDepInfo(depsInfo),
  )

  /**
   * Rolldown 在后台预构建依赖。请求侧不在这里阻塞，而是在 optimizedDepsPlugin.load
   * 中按具体依赖等待 optimizedDepInfo.processing。
   */

  const qualifiedIds = Object.keys(depsInfo)
  let cleaned = false
  let committed = false
  const cleanUp = () => {
    // If commit was already called, ignore the clean up even if a cancel was requested
    // This minimizes the chances of leaving the deps cache in a corrupted state
    if (!cleaned && !committed) {
      cleaned = true
      // No need to wait, we can clean up in the background because temp folders
      // are unique per run
      debug?.(colors.green(`removing cache dir ${processingCacheDir}`))
      try {
        // When exiting the process, `fsp.rm` may not take effect, so we use `fs.rmSync`
        fs.rmSync(processingCacheDir, { recursive: true, force: true })
      } catch {
        // Ignore errors
      }
    }
  }

  const successfulResult: DepOptimizationResult = {
    metadata,
    cancel: cleanUp,
    commit: async () => {
      if (cleaned) {
        throw new Error(
          'Can not commit a Deps Optimization run as it was cancelled',
        )
      }
      // Ignore clean up requests after this point so the temp folder isn't deleted before
      // we finish committing the new deps cache files to the deps folder
      committed = true

      /**
       * commit 是正式缓存的唯一提交点：
       * 先在 processing 目录写 _metadata.json，再把 metadata 中的文件路径序列化为
       * 正式 deps 目录，最后通过目录 rename 替换旧缓存。
       */
      const dataPath = path.join(processingCacheDir, METADATA_FILENAME) // 🔖断点[小册04] commit:先把 metadata 写进临时目录，再 rename 成正式 deps 缓存
      debug?.(
        colors.green(`creating ${METADATA_FILENAME} in ${processingCacheDir}`),
      )
      fs.writeFileSync(
        dataPath,
        stringifyDepsOptimizerMetadata(metadata, depsCacheDir),
      )

      // In order to minimize the time where the deps folder isn't in a consistent state,
      // we first rename the old depsCacheDir to a temporary path, then we rename the
      // new processing cache dir to the depsCacheDir. In systems where doing so in sync
      // is safe, we do an atomic operation (at least for this thread). For Windows, we
      // found there are cases where the rename operation may finish before it's done
      // so we do a graceful rename checking that the folder has been properly renamed.
      // We found that the rename-rename (then delete the old folder in the background)
      // is safer than a delete-rename operation.
      const temporaryPath = depsCacheDir + getTempSuffix()
      const depsCacheDirPresent = fs.existsSync(depsCacheDir)
      if (isWindows) {
        if (depsCacheDirPresent) {
          debug?.(colors.green(`renaming ${depsCacheDir} to ${temporaryPath}`))
          await safeRename(depsCacheDir, temporaryPath)
        }
        debug?.(
          colors.green(`renaming ${processingCacheDir} to ${depsCacheDir}`),
        )
        await safeRename(processingCacheDir, depsCacheDir)
      } else {
        if (depsCacheDirPresent) {
          debug?.(colors.green(`renaming ${depsCacheDir} to ${temporaryPath}`))
          fs.renameSync(depsCacheDir, temporaryPath)
        }
        debug?.(
          colors.green(`renaming ${processingCacheDir} to ${depsCacheDir}`),
        )
        fs.renameSync(processingCacheDir, depsCacheDir)
      }

      // Delete temporary path in the background
      if (depsCacheDirPresent) {
        debug?.(colors.green(`removing cache temp dir ${temporaryPath}`))
        fsp.rm(temporaryPath, { recursive: true, force: true })
      }
    },
  }

  if (!qualifiedIds.length) {
    /**
     * 即使本轮没有依赖，也返回一个可 commit 的空结果：
     * 上层提交后可以清除旧产物并保存空 metadata，使下次启动在哈希未变时跳过扫描。
     */
    return {
      cancel: async () => cleanUp(),
      result: Promise.resolve(successfulResult),
    }
  }

  const cancelledResult: DepOptimizationResult = {
    metadata,
    commit: async () => cleanUp(),
    cancel: cleanUp,
  }

  const start = performance.now()

  const bundleTimer = setTimeout(() => {
    environment.logger.info('[optimizer] bundling dependencies...', {
      timestamp: true,
    })
  }, 1000)

  /**
   * 准备 Rolldown context、预构建专用插件和每个入口的 exports 分析结果。
   * prepare 与 build 分开，使 cancel() 在构建开始前后都能拿到 context 并终止任务。
   */
  const preparedRun = prepareRolldownOptimizerRun(
    environment,
    depsInfo,
    processingCacheDir,
    optimizerContext,
  )

  const runResult = preparedRun.then(({ context, idToExports }) => {
    if (!context || optimizerContext.cancelled) {
      clearTimeout(bundleTimer)
      return cancelledResult
    }

    return context
      .build()
      .then((result) => {
        const depForEntryFileName: Record<string, OptimizedDepInfo> = {}
        for (const dep of Object.values(depsInfo)) {
          const entryFileName = flattenId(dep.id) + '.js'
          depForEntryFileName[entryFileName] = dep
        }

        /**
         * 把 Rolldown 输出反向登记到 metadata：
         * entry chunk 进入 optimized，并计算 fileHash/needsInterop；
         * 共享或动态 chunk 进入 chunks，供请求侧按文件路径查找。
         */
        for (const chunk of result.output) {
          if (chunk.type !== 'chunk') continue

          if (chunk.isEntry) {
            const { exportsData, file, id, ...info } =
              depForEntryFileName[chunk.fileName]
            addOptimizedDepInfo(metadata, 'optimized', {
              id,
              file,
              ...info,
              // We only need to hash the chunk.imports in to check for stability, but adding the hash
              // and file path gives us a unique hash that may be useful for other things in the future
              fileHash: getHash(
                metadata.hash + file + JSON.stringify(chunk.imports),
              ),
              browserHash: metadata.browserHash,
              // After bundling we have more information and can warn the user about legacy packages
              // that require manual configuration
              needsInterop: needsInterop(
                environment,
                id,
                idToExports[id],
                chunk,
              ),
            })
          } else {
            const id = chunk.fileName.replace(jsExtensionRE, '')
            const file = normalizePath(
              path.resolve(getDepsCacheDir(environment), chunk.fileName),
            )
            if (
              !findOptimizedDepInfoInRecord(
                metadata.optimized,
                (depInfo) => depInfo.file === file,
              )
            ) {
              addOptimizedDepInfo(metadata, 'chunks', {
                id,
                file,
                needsInterop: false,
                browserHash: metadata.browserHash,
                isDynamicEntry: chunk.isDynamicEntry,
              })
            }
          }
        }

        clearTimeout(bundleTimer)

        debug?.(
          `Dependencies bundled in ${(performance.now() - start).toFixed(2)}ms`,
        )

        return successfulResult
      })

      .catch((e) => {
        clearTimeout(bundleTimer)
        if (e.errors && e.message.includes('The build was canceled')) {
          // an error happens when cancelling, but this is expected so
          // return an empty result instead
          return cancelledResult
        }
        const prependMessage = colors.red(
          'Error during dependency optimization:\n\n',
        )
        e.message = prependMessage + e.message
        throw e
      })
  })

  runResult.catch(() => {
    cleanUp()
  })

  return {
    async cancel() {
      // 取消 Rolldown 构建并删除本轮 processing 目录，不触碰已提交的正式缓存。
      optimizerContext.cancelled = true
      const { context } = await preparedRun
      context?.cancel()
      cleanUp()
    },
    result: runResult,
  }
}

async function prepareRolldownOptimizerRun(
  environment: Environment,
  depsInfo: Record<string, OptimizedDepInfo>,
  processingCacheDir: string,
  optimizerContext: { cancelled: boolean },
): Promise<{
  context?: { build: () => Promise<RolldownOutput>; cancel: () => void }
  idToExports: Record<string, ExportsData>
}> {
  // esbuild generates nested directory output with lowest common ancestor base
  // this is unpredictable and makes it difficult to analyze entry / output
  // mapping. So what we do here is:
  // 1. flatten all ids to eliminate slash
  // 2. in the plugin, read the entry ourselves as virtual files to retain the
  //    path.
  const flatIdDeps: Record<string, string> = {}
  const idToExports: Record<string, ExportsData> = {}

  const { optimizeDeps } = environment.config

  const { plugins: pluginsFromConfig = [], ...rolldownOptions } =
    optimizeDeps.rolldownOptions ?? {}

  let jsxLoader = false
  await Promise.all(
    Object.keys(depsInfo).map(async (id) => {
      const src = depsInfo[id].src!
      const exportsData = await (depsInfo[id].exportsData ??
        extractExportsData(environment, src))
      if (exportsData.jsxLoader) {
        // Ensure that optimization won't fail by defaulting '.js' to the JSX parser.
        // This is useful for packages such as Gatsby.
        jsxLoader = true
      }
      const flatId = flattenId(id)
      flatIdDeps[flatId] = isWindows ? src.replaceAll('/', '\\') : src
      idToExports[id] = exportsData
    }),
  )

  if (optimizerContext.cancelled) return { context: undefined, idToExports }

  const define = {
    'process.env.NODE_ENV': environment.config.keepProcessEnv
      ? // define process.env.NODE_ENV even for keepProcessEnv === true
        // as esbuild will replace it automatically when `platform` is `'browser'`
        'process.env.NODE_ENV'
      : JSON.stringify(process.env.NODE_ENV || environment.config.mode),
    ...rolldownOptions.transform?.define,
  }

  const platform =
    optimizeDeps.rolldownOptions?.platform ??
    // We generally don't want to use platform 'neutral', as esbuild has custom handling
    // when the platform is 'node' or 'browser' that can't be emulated by using mainFields
    // and conditions
    (environment.config.consumer === 'client' ||
    environment.config.ssr.target === 'webworker'
      ? 'browser'
      : 'node')

  const external = [...(optimizeDeps.exclude ?? [])]

  /**
   * 核心逻辑：flatIdDeps 是 Rolldown 预打包的入口表。
   * Vite 先把依赖 id 映射成稳定的扁平文件名，再交给 rolldownDepPlugin 处理 CJS/ESM 兼容。
   */
  const plugins = await asyncFlatten(arraify(pluginsFromConfig))
  if (external.length) {
    plugins.push(rolldownCjsExternalPlugin(external, platform))
  }
  plugins.push(...rolldownDepPlugin(environment, flatIdDeps, external))

  let canceled = false
  async function build() {
    const bundle = await rolldown({ // 🔖断点[专题02] dev 依赖预构建也用 Rolldown(Vite 7 时这里是 esbuild),单引擎收敛的 dev 侧体现 // 🔖断点[小册04] 用 Rolldown 预打包依赖:看 input(flatIdDeps) 有哪些依赖
      ...rolldownOptions, // 小册说明：这里的 Rolldown 只负责依赖预构建；默认 dev 请求期转换仍走插件容器与 Oxc。
      input: flatIdDeps,
      logLevel: 'silent',
      plugins,
      platform,
      transform: {
        target: ESBUILD_BASELINE_WIDELY_AVAILABLE_TARGET,
        ...rolldownOptions.transform,
        define,
      },
      resolve: {
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'],
        ...rolldownOptions.resolve,
      },
      // TODO: remove this and enable rolldown's CSS support later
      moduleTypes: {
        '.css': 'js',
        ...rolldownOptions.moduleTypes,
        ...(jsxLoader ? { '.js': 'jsx' } : {}),
      },
    })
    if (canceled) {
      await bundle.close()
      throw new Error('The build was canceled')
    }
    try {
      return await bundle.write({
        ...rolldownOptions.output,
        format: 'esm',
        sourcemap: 'hidden',
        dir: processingCacheDir,
        entryFileNames: '[name].js',
      })
    } finally {
      await bundle.close()
    }
  }

  function cancel() {
    canceled = true
  }

  return { context: { build, cancel }, idToExports }
}

export async function addManuallyIncludedOptimizeDeps(
  environment: Environment,
  deps: Record<string, string>,
): Promise<void> {
  const { logger } = environment
  const { optimizeDeps } = environment.config
  const optimizeDepsInclude = optimizeDeps.include ?? []
  if (optimizeDepsInclude.length) {
    const unableToOptimize = (id: string, msg: string) => {
      if (optimizeDepsInclude.includes(id)) {
        logger.warn(
          `${msg}: ${colors.cyan(id)}, present in ${environment.name} 'optimizeDeps.include'`,
        )
      }
    }

    const includes = [...optimizeDepsInclude]
    for (let i = 0; i < includes.length; i++) {
      const id = includes[i]
      if (isDynamicPattern(id)) {
        const globIds = expandGlobIds(id, environment.getTopLevelConfig())
        includes.splice(i, 1, ...globIds)
        i += globIds.length - 1
      }
    }

    const resolve = createOptimizeDepsIncludeResolver(environment)
    for (const id of includes) {
      // normalize 'foo   >bar` as 'foo > bar' to prevent same id being added
      // and for pretty printing
      const normalizedId = normalizeId(id)
      if (!deps[normalizedId]) {
        const entry = await resolve(id)
        if (entry) {
          if (isOptimizable(entry, optimizeDeps)) {
            deps[normalizedId] = entry
          } else {
            unableToOptimize(id, 'Cannot optimize dependency')
          }
        } else {
          unableToOptimize(id, 'Failed to resolve dependency')
        }
      }
    }
  }
}

// Convert to { id: src }
export function depsFromOptimizedDepInfo(
  depsInfo: Record<string, OptimizedDepInfo>,
): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const key in depsInfo) {
    obj[key] = depsInfo[key].src!
  }
  return obj
}

export function getOptimizedDepPath(
  environment: Environment,
  id: string,
): string {
  return normalizePath(
    path.resolve(getDepsCacheDir(environment), flattenId(id) + '.js'),
  )
}

function getDepsCacheSuffix(environment: Environment): string {
  return environment.name === 'client' ? '' : `_${environment.name}`
}

export function getDepsCacheDir(environment: Environment): string {
  return getDepsCacheDirPrefix(environment) + getDepsCacheSuffix(environment)
}

function getProcessingDepsCacheDir(environment: Environment) {
  return (
    getDepsCacheDirPrefix(environment) +
    getDepsCacheSuffix(environment) +
    getTempSuffix()
  )
}

function getTempSuffix() {
  return (
    '_temp_' +
    getHash(
      `${process.pid}:${Date.now().toString()}:${Math.random()
        .toString(16)
        .slice(2)}`,
    )
  )
}

function getDepsCacheDirPrefix(environment: Environment): string {
  return normalizePath(path.resolve(environment.config.cacheDir, 'deps'))
}

export function createIsOptimizedDepFile(
  environment: Environment,
): (id: string) => boolean {
  const depsCacheDirPrefix = getDepsCacheDirPrefix(environment)
  return (id) => id.startsWith(depsCacheDirPrefix)
}

export function createIsOptimizedDepUrl(
  environment: Environment,
): (url: string) => boolean {
  const { root } = environment.config
  const depsCacheDir = getDepsCacheDirPrefix(environment)

  // determine the url prefix of files inside cache directory
  const depsCacheDirRelative = normalizePath(path.relative(root, depsCacheDir))
  const depsCacheDirPrefix = depsCacheDirRelative.startsWith('../')
    ? // if the cache directory is outside root, the url prefix would be something
      // like '/@fs/absolute/path/to/node_modules/.vite'
      `/@fs/${removeLeadingSlash(normalizePath(depsCacheDir))}`
    : // if the cache directory is inside root, the url prefix would be something
      // like '/node_modules/.vite'
      `/${depsCacheDirRelative}`

  return function isOptimizedDepUrl(url: string): boolean {
    return url.startsWith(depsCacheDirPrefix)
  }
}

function parseDepsOptimizerMetadata(
  jsonMetadata: string,
  depsCacheDir: string,
): DepOptimizationMetadata | undefined {
  const { hash, lockfileHash, configHash, browserHash, optimized, chunks } =
    JSON.parse(jsonMetadata, (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === 'file' || key === 'src') {
        return normalizePath(path.resolve(depsCacheDir, value))
      }
      return value
    })
  if (
    !chunks ||
    Object.values(optimized).some((depInfo: any) => !depInfo.fileHash)
  ) {
    // outdated _metadata.json version, ignore
    return
  }
  const metadata = {
    hash,
    lockfileHash,
    configHash,
    browserHash,
    optimized: {},
    discovered: {},
    chunks: {},
    depInfoList: [],
  }
  for (const id of Object.keys(optimized)) {
    addOptimizedDepInfo(metadata, 'optimized', {
      ...optimized[id],
      id,
      browserHash,
    })
  }
  for (const id of Object.keys(chunks)) {
    addOptimizedDepInfo(metadata, 'chunks', {
      ...chunks[id],
      id,
      browserHash,
      needsInterop: false,
    })
  }
  return metadata
}

/**
 * Stringify metadata for deps cache. Remove processing promises
 * and individual dep info browserHash. Once the cache is reload
 * the next time the server start we need to use the global
 * browserHash to allow long term caching
 */
function stringifyDepsOptimizerMetadata(
  metadata: DepOptimizationMetadata,
  depsCacheDir: string,
) {
  const { hash, configHash, lockfileHash, browserHash, optimized, chunks } =
    metadata
  return JSON.stringify(
    {
      hash,
      configHash,
      lockfileHash,
      browserHash,
      optimized: Object.fromEntries(
        Object.values(optimized).map(
          ({ id, src, file, fileHash, needsInterop, isDynamicEntry }) => [
            id,
            {
              src,
              file,
              fileHash,
              needsInterop,
              isDynamicEntry,
            },
          ],
        ),
      ),
      chunks: Object.fromEntries(
        Object.values(chunks).map(({ id, file, isDynamicEntry }) => [
          id,
          { file, isDynamicEntry },
        ]),
      ),
    },
    (key: string, value: string) => {
      // Paths can be absolute or relative to the deps cache dir where
      // the _metadata.json is located
      if (key === 'file' || key === 'src') {
        return normalizePath(path.relative(depsCacheDir, value))
      }
      return value
    },
    2,
  )
}

export async function extractExportsData(
  environment: Environment,
  filePath: string,
): Promise<ExportsData> {
  await init

  const { optimizeDeps } = environment.config

  const rolldownOptions = optimizeDeps.rolldownOptions ?? {}
  if (optimizeDeps.extensions?.some((ext) => filePath.endsWith(ext))) {
    // For custom supported extensions, build the entry file to transform it into JS,
    // and then parse with es-module-lexer. Note that the `bundle` option is not `true`,
    // so only the entry file is being transformed.
    const { plugins: pluginsFromConfig = [], ...remainingRolldownOptions } =
      rolldownOptions
    const plugins = await asyncFlatten(arraify(pluginsFromConfig))
    plugins.unshift({
      name: 'externalize',
      resolveId(id, importer) {
        if (importer !== undefined) {
          return { id, external: true }
        }
      },
    })
    const build = await rolldown({
      ...remainingRolldownOptions,
      plugins,
      input: [filePath],
      // TODO: remove this and enable rolldown's CSS support later
      moduleTypes: {
        '.css': 'js',
        ...remainingRolldownOptions.moduleTypes,
      },
    })
    const result = await build.generate({
      ...rolldownOptions.output,
      format: 'esm',
      sourcemap: false,
    })
    const [, exports, , hasModuleSyntax] = parse(result.output[0].code)
    return {
      hasModuleSyntax,
      exports: exports.map((e) => e.n),
    }
  }

  let parseResult: ReturnType<typeof parse>
  let usedJsxLoader = false

  const entryContent = fs.readFileSync(filePath, 'utf-8')
  try {
    parseResult = parse(entryContent)
  } catch {
    const lang = rolldownOptions.moduleTypes?.[path.extname(filePath)] || 'jsx'
    debug?.(
      `Unable to parse: ${filePath}.\n Trying again with a ${lang} transform.`,
    )
    if (lang !== 'jsx' && lang !== 'tsx' && lang !== 'ts') {
      throw new Error(`Unable to parse: ${filePath}.`)
    }
    const transformed = await transformWithOxc(
      entryContent,
      filePath,
      { lang },
      undefined,
      environment.config,
    )
    parseResult = parse(transformed.code)
    usedJsxLoader = true
  }

  const [, exports, , hasModuleSyntax] = parseResult
  const exportsData: ExportsData = {
    hasModuleSyntax,
    exports: exports.map((e) => e.n),
    jsxLoader: usedJsxLoader,
  }
  return exportsData
}

function needsInterop(
  environment: Environment,
  id: string,
  exportsData: ExportsData,
  output?: { exports: string[] },
): boolean {
  if (environment.config.optimizeDeps.needsInterop?.includes(id)) {
    return true
  }
  const { hasModuleSyntax, exports } = exportsData
  // entry has no ESM syntax - likely CJS or UMD
  if (!hasModuleSyntax) {
    return true
  }

  if (output) {
    // if a peer dependency used require() on an ESM dependency, esbuild turns the
    // ESM dependency's entry chunk into a single default export... detect
    // such cases by checking exports mismatch, and force interop.
    const generatedExports: string[] = output.exports

    if (
      isSingleDefaultExport(generatedExports) &&
      !isSingleDefaultExport(exports)
    ) {
      return true
    }
  }
  return false
}

function isSingleDefaultExport(exports: readonly string[]) {
  return exports.length === 1 && exports[0] === 'default'
}

const lockfileFormats = [
  {
    path: 'node_modules/.package-lock.json',
    checkPatchesDir: 'patches',
    manager: 'npm',
  },
  {
    // Yarn non-PnP
    path: 'node_modules/.yarn-state.yml',
    checkPatchesDir: false,
    manager: 'yarn',
  },
  {
    // Yarn v3+ PnP
    path: '.pnp.cjs',
    checkPatchesDir: '.yarn/patches',
    manager: 'yarn',
  },
  {
    // Yarn v2 PnP
    path: '.pnp.js',
    checkPatchesDir: '.yarn/patches',
    manager: 'yarn',
  },
  {
    // yarn 1
    path: 'node_modules/.yarn-integrity',
    checkPatchesDir: 'patches',
    manager: 'yarn',
  },
  {
    path: 'node_modules/.pnpm/lock.yaml',
    // Included in lockfile
    checkPatchesDir: false,
    manager: 'pnpm',
  },
  {
    path: '.rush/temp/shrinkwrap-deps.json',
    // Included in lockfile
    checkPatchesDir: false,
    manager: 'pnpm',
  },
  {
    path: 'bun.lock',
    checkPatchesDir: 'patches',
    manager: 'bun',
  },
  {
    path: 'bun.lockb',
    checkPatchesDir: 'patches',
    manager: 'bun',
  },
].sort((_, { manager }) => {
  return process.env.npm_config_user_agent?.startsWith(manager) ? 1 : -1
})
const lockfilePaths = lockfileFormats.map((l) => l.path)

function getConfigHash(environment: Environment): string {
  // Take config into account
  // only a subset of config options that can affect dep optimization
  const { config } = environment
  const { optimizeDeps } = config
  const content = JSON.stringify(
    {
      define: !config.keepProcessEnv
        ? process.env.NODE_ENV || config.mode
        : null,
      root: config.root,
      resolve: config.resolve,
      assetsInclude: config.assetsInclude,
      plugins: config.plugins.map((p) => p.name),
      optimizeDeps: {
        include: optimizeDeps.include
          ? unique(optimizeDeps.include).sort()
          : undefined,
        exclude: optimizeDeps.exclude
          ? unique(optimizeDeps.exclude).sort()
          : undefined,
        rolldownOptions: {
          ...optimizeDeps.rolldownOptions,
          plugins: undefined, // included in optimizeDepsPluginNames
          onLog: undefined,
          onwarn: undefined,
          checks: undefined,
          output: {
            ...optimizeDeps.rolldownOptions?.output,
            plugins: undefined, // included in optimizeDepsPluginNames
          },
        },
      },
      optimizeDepsPluginNames: config.optimizeDepsPluginNames,
    },
    (_, value) => {
      if (typeof value === 'function' || value instanceof RegExp) {
        return value.toString()
      }
      return value
    },
  )
  return getHash(content)
}

function getLockfileHash(environment: Environment): string {
  const lockfilePath = lookupFile(environment.config.root, lockfilePaths)
  let content = lockfilePath ? fs.readFileSync(lockfilePath, 'utf-8') : ''
  if (lockfilePath) {
    const normalizedLockfilePath = lockfilePath.replaceAll('\\', '/')
    const lockfileFormat = lockfileFormats.find((f) =>
      normalizedLockfilePath.endsWith(f.path),
    )!
    if (lockfileFormat.checkPatchesDir) {
      // Default of https://github.com/ds300/patch-package
      const baseDir = lockfilePath.slice(0, -lockfileFormat.path.length)
      const fullPath = path.join(
        baseDir,
        lockfileFormat.checkPatchesDir as string,
      )
      const stat = tryStatSync(fullPath)
      if (stat?.isDirectory()) {
        content += stat.mtimeMs.toString()
      }
    }
  }
  return getHash(content)
}

function getDepHash(environment: Environment): {
  lockfileHash: string
  configHash: string
  hash: string
} {
  const lockfileHash = getLockfileHash(environment)
  const configHash = getConfigHash(environment)
  const hash = getHash(lockfileHash + configHash)
  return {
    hash,
    lockfileHash,
    configHash,
  }
}

function getOptimizedBrowserHash(
  hash: string,
  deps: Record<string, string>,
  timestamp = '',
) {
  return getHash(hash + JSON.stringify(deps) + timestamp)
}

export function optimizedDepInfoFromId(
  metadata: DepOptimizationMetadata,
  id: string,
): OptimizedDepInfo | undefined {
  return (
    metadata.optimized[id] || metadata.discovered[id] || metadata.chunks[id]
  )
}

export function optimizedDepInfoFromFile(
  metadata: DepOptimizationMetadata,
  file: string,
): OptimizedDepInfo | undefined {
  return metadata.depInfoList.find((depInfo) => depInfo.file === file)
}

function findOptimizedDepInfoInRecord(
  dependenciesInfo: Record<string, OptimizedDepInfo>,
  callbackFn: (depInfo: OptimizedDepInfo, id: string) => any,
): OptimizedDepInfo | undefined {
  for (const o of Object.keys(dependenciesInfo)) {
    const info = dependenciesInfo[o]
    if (callbackFn(info, o)) {
      return info
    }
  }
}

export async function optimizedDepNeedsInterop(
  environment: Environment,
  metadata: DepOptimizationMetadata,
  file: string,
): Promise<boolean | undefined> {
  const depInfo = optimizedDepInfoFromFile(metadata, file)
  if (depInfo?.src && depInfo.needsInterop === undefined) {
    depInfo.exportsData ??= extractExportsData(environment, depInfo.src)
    depInfo.needsInterop = needsInterop(
      environment,
      depInfo.id,
      await depInfo.exportsData,
    )
  }
  return depInfo?.needsInterop
}

const MAX_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000
export async function cleanupDepsCacheStaleDirs(
  config: ResolvedConfig,
): Promise<void> {
  try {
    const cacheDir = path.resolve(config.cacheDir)
    if (fs.existsSync(cacheDir)) {
      const dirents = await fsp.readdir(cacheDir, { withFileTypes: true })
      for (const dirent of dirents) {
        if (dirent.isDirectory() && dirent.name.includes('_temp_')) {
          const tempDirPath = path.resolve(config.cacheDir, dirent.name)
          const stats = await fsp.stat(tempDirPath).catch(() => null)
          if (
            stats?.mtime &&
            Date.now() - stats.mtime.getTime() > MAX_TEMP_DIR_AGE_MS
          ) {
            debug?.(`removing stale cache temp dir ${tempDirPath}`)
            await fsp.rm(tempDirPath, { recursive: true, force: true })
          }
        }
      }
    }
  } catch (err) {
    config.logger.error(err)
  }
}

// We found issues with renaming folders in some systems. This is a custom
// implementation for the optimizer. It isn't intended to be a general utility

// Based on node-graceful-fs

// The ISC License
// Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors
// https://github.com/isaacs/node-graceful-fs/blob/main/LICENSE

// On Windows, A/V software can lock the directory, causing this
// to fail with an EACCES or EPERM if the directory contains newly
// created files. The original tried for up to 60 seconds, we only
// wait for 5 seconds, as a longer time would be seen as an error

const GRACEFUL_RENAME_TIMEOUT = 5000
const safeRename = promisify(function gracefulRename(
  from: string,
  to: string,
  cb: (error: NodeJS.ErrnoException | null) => void,
) {
  const start = Date.now()
  let backoff = 0
  fs.rename(from, to, function CB(er) {
    if (
      er &&
      (er.code === 'EACCES' || er.code === 'EPERM') &&
      Date.now() - start < GRACEFUL_RENAME_TIMEOUT
    ) {
      setTimeout(function () {
        fs.stat(to, function (stater, _st) {
          if (stater && stater.code === 'ENOENT') fs.rename(from, to, CB)
          else CB(er)
        })
      }, backoff)
      if (backoff < 100) backoff += 10
      return
    }
    cb(er)
  })
})
