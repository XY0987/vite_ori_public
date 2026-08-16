import colors from 'picocolors'
import { createDebugger, getHash } from '../utils'
import {
  type PromiseWithResolvers,
  promiseWithResolvers,
} from '../../shared/utils'
import type { DevEnvironment } from '../server/environment'
import { devToScanEnvironment } from './scan'
import {
  addManuallyIncludedOptimizeDeps,
  addOptimizedDepInfo,
  createIsOptimizedDepFile,
  createIsOptimizedDepUrl,
  depsFromOptimizedDepInfo,
  depsLogString,
  discoverProjectDependencies,
  extractExportsData,
  getOptimizedDepPath,
  initDepsOptimizerMetadata,
  loadCachedDepOptimizationMetadata,
  optimizeExplicitEnvironmentDeps,
  runOptimizeDeps,
  toDiscoveredDependencies,
} from './index'
import type {
  DepOptimizationMetadata,
  DepOptimizationResult,
  DepsOptimizer,
  OptimizedDepInfo,
} from './index'

const debug = createDebugger('vite:deps')

/**
 * The amount to wait for requests to register newly found dependencies before triggering
 * a re-bundle + page reload
 */
const debounceMs = 100

/**
 * 自动发现模式（optimizeDeps.noDiscovery=false）的环境级 optimizer。
 *
 * 依赖来源有三类：
 * 1. optimizeDeps.include：init 时明确加入首批 discovered；
 * 2. discoverProjectDependencies：冷启动后台扫描入口文件和静态 import；
 * 3. registerMissingImport：真实请求 crawl 或后续运行期间发现扫描遗漏的裸依赖。
 *
 * 三类依赖会合并成批次交给 runOptimizeDeps，而不是每个请求单独立即构建。
 */
export function createDepsOptimizer(
  environment: DevEnvironment,
): DepsOptimizer {
  const { logger } = environment
  const sessionTimestamp = Date.now().toString()

  let debounceProcessingHandle: NodeJS.Timeout | undefined

  let closed = false

  const options = environment.config.optimizeDeps

  const { noDiscovery, holdUntilCrawlEnd } = options

  let metadata: DepOptimizationMetadata = initDepsOptimizerMetadata(
    environment,
    sessionTimestamp,
  )

  const depsOptimizer: DepsOptimizer = {
    init,
    metadata,
    registerMissingImport,
    run: () => debouncedProcessing(0),
    isOptimizedDepFile: createIsOptimizedDepFile(environment),
    isOptimizedDepUrl: createIsOptimizedDepUrl(environment),
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      `${depInfo.file}?v=${depInfo.browserHash}`,
    close,
    options,
  }

  let newDepsDiscovered = false

  let newDepsToLog: string[] = []
  let newDepsToLogHandle: NodeJS.Timeout | undefined
  const logNewlyDiscoveredDeps = () => {
    if (newDepsToLog.length) {
      logger.info(
        colors.green(
          `✨ new dependencies optimized: ${depsLogString(newDepsToLog)}`,
        ),
        {
          timestamp: true,
        },
      )
      newDepsToLog = []
    }
  }

  let discoveredDepsWhileScanning: string[] = []
  const logDiscoveredDepsWhileScanning = () => {
    if (discoveredDepsWhileScanning.length) {
      logger.info(
        colors.green(
          `✨ discovered while scanning: ${depsLogString(
            discoveredDepsWhileScanning,
          )}`,
        ),
        {
          timestamp: true,
        },
      )
      discoveredDepsWhileScanning = []
    }
  }

  let depOptimizationProcessing = promiseWithResolvers<void>()
  let depOptimizationProcessingQueue: PromiseWithResolvers<void>[] = []
  const resolveEnqueuedProcessingPromises = () => {
    // Resolve all the processings (including the ones which were delayed)
    for (const processing of depOptimizationProcessingQueue) {
      processing.resolve()
    }
    depOptimizationProcessingQueue = []
  }

  let enqueuedRerun: (() => void) | undefined
  let currentlyProcessing = false

  let firstRunCalled = false
  let warnAboutMissedDependencies = false

  // If this is a cold run, we wait for static imports discovered
  // from the first request before resolving to minimize full page reloads.
  // On warm start or after the first optimization is run, we use a simpler
  // debounce strategy each time a new dep is discovered.
  let waitingForCrawlEnd = false

  let optimizationResult:
    | {
        cancel: () => Promise<void>
        result: Promise<DepOptimizationResult>
      }
    | undefined

  let discover:
    | {
        cancel: () => Promise<void>
        result: Promise<Record<string, string>>
      }
    | undefined

  async function close() {
    closed = true
    await Promise.allSettled([
      discover?.cancel(),
      depsOptimizer.scanProcessing,
      optimizationResult?.cancel(),
    ])
  }

  let inited = false
  async function init() { // 🔖断点[小册04] 显式 include 模式 init:只优化 optimizeDeps.include，不做自动发现
    if (inited) return
    inited = true

    /**
     * 核心逻辑：预构建的第一分叉不是“扫不扫描”，而是“缓存还能不能信”。
     * 缓存命中时直接复用 metadata；缓存失效时才进入扫描、发现、打包这套状态机。
     */
    const cachedMetadata = await loadCachedDepOptimizationMetadata(environment) // 🔖断点[小册04] 预构建入口:有缓存=热启动(跳过扫描),无=冷启动

    firstRunCalled = !!cachedMetadata

    metadata = depsOptimizer.metadata =
      cachedMetadata || initDepsOptimizerMetadata(environment, sessionTimestamp)

    // cachedMetadata 存在时就是文章里的“热启动”：直接复用缓存 metadata，
    // 冷启动才会执行启动阶段的 scan 和 runOptimizeDeps。
    if (!cachedMetadata) {
      /**
       * 走到这里说明缓存没有命中，也就是文章里的“冷启动”。
       *
       * 冷启动不是只做一次扫描，而是同时启动两条依赖发现路径：
       * 1. scan：后台调用 discoverProjectDependencies，主动扫描入口和静态 import；
       * 2. crawl：浏览器真实请求源码模块，触发 transformRequest，并按插件链执行
       *    resolveId/load/transform；如果 resolve/import analysis 发现裸依赖，
       *    就通过 registerMissingImport 记录到 metadata.discovered。
       *
       * waitForRequestsIdle 只负责判断首轮源码模块请求是否空闲；真正的依赖收集发生在
       * resolve/import analysis 链路里。最后比较 scanDeps 与 crawlDeps，必要时合并后重跑，
       * 尽量减少页面二次 reload。
       */
      waitingForCrawlEnd = true

      // 冷启动期间先进入 processing 状态，直到首轮请求触发的源码模块 crawl 结束。
      currentlyProcessing = true

      /**
       * 冷启动的第一步：先把 optimizeDeps.include 手动声明的依赖放进 discovered。
       *
       * 可以把 metadata.discovered 理解成“本轮已经发现、等待预构建或
       * 正在预构建的依赖清单”。后面的 scan 结果和请求 crawl 结果也都会汇总到这里。
       */

      const manuallyIncludedDeps: Record<string, string> = {}
      await addManuallyIncludedOptimizeDeps(environment, manuallyIncludedDeps)

      const manuallyIncludedDepsInfo = toDiscoveredDependencies(
        environment,
        manuallyIncludedDeps,
        sessionTimestamp,
      )

      for (const depInfo of Object.values(manuallyIncludedDepsInfo)) {
        addOptimizedDepInfo(metadata, 'discovered', {
          ...depInfo,
          processing: depOptimizationProcessing.promise,
        })
        newDepsDiscovered = true
      }

      /**
       * 启动“首轮 crawl 结束”的监听。
       *
       * 这里不会主动发请求，也不会扫描源码；它只是等 transformRequest 登记的模块请求
       * 都处理完并空闲一小段时间后，调用 onCrawlEnd 去汇总 crawlDeps 和 scanDeps。
       */
      environment.waitForRequestsIdle().then(onCrawlEnd)

      if (noDiscovery) {
        /**
         * noDiscovery=true 对应文章里的“显式 include 模式”。
         *
         * 注意：optimizeDeps.include 不是在 runOptimizer 里收集的。前面已经通过
         * addManuallyIncludedOptimizeDeps + addOptimizedDepInfo，把 include 展开并放进
         * metadata.discovered 了。
         *
         * 这个分支的作用是决定“后续不再自动发现”：不启动 discoverProjectDependencies，
         * 也不等待首轮请求 crawl 汇总依赖，而是直接消费当前 metadata.discovered，
         * 启动并提交一轮预构建。
         */
        runOptimizer()
      } else {
        /**
         * 冷启动的第二条线：后台 scan + 首次预构建。
         *
         * scanProcessing 对应文章流程图里的：
         * discoverProjectDependencies -> runOptimizeDeps -> 等 onCrawlEnd 决定是否 commit。
         *
         * 这里包一层 Promise，是为了把“后台扫描和预构建是否结束”暴露给 onCrawlEnd。
         * onCrawlEnd 会先 await depsOptimizer.scanProcessing，确保 scanDeps 和候选优化结果
         * 都准备好，再和请求 crawl 得到的 crawlDeps 做比较。
         */
        depsOptimizer.scanProcessing = new Promise((resolve) => {
          // Runs in the background in case blocking high priority tasks
          ;(async () => {
            try {
              debug?.(colors.green(`scanning for dependencies...`))

              const scanTimer = setTimeout(() => {
                logger.info('[optimizer] scanning dependencies...', {
                  timestamp: true,
                })
              }, 1000)

              let deps: Record<string, string>
              try {
                discover = discoverProjectDependencies(
                  devToScanEnvironment(environment),
                )
                deps = await discover.result
                discover = undefined
              } catch (e) {
                environment.logger.error(
                  colors.red(
                    '(!) Failed to run dependency scan. ' +
                      'Skipping dependency pre-bundling. ' +
                      e.stack,
                  ),
                )
                return
              } finally {
                clearTimeout(scanTimer)
              }

              /**
               * scan 在后台跑的时候，浏览器请求也可能已经触发 transformRequest。
               * 这些请求如果发现了 scan 没扫到的裸依赖，会先写进 metadata.discovered。
               * 这里把“请求 crawl 发现、但 scan 没发现”的依赖先记录下来，后面用于判断
               * 扫描结果是否过期，避免把一个不完整的预构建结果直接交给浏览器。
               */
              const manuallyIncluded = Object.keys(manuallyIncludedDepsInfo)
              discoveredDepsWhileScanning.push(
                ...Object.keys(metadata.discovered).filter(
                  (dep) => !deps[dep] && !manuallyIncluded.includes(dep),
                ),
              )

              /**
               * scan 得到的依赖也合并进 metadata.discovered。
               *
               * 到这里，metadata.discovered 里可能同时包含三类依赖：
               * - optimizeDeps.include 手动声明的依赖；
               * - 请求 crawl 过程中 registerMissingImport 发现的依赖；
               * - discoverProjectDependencies 后台扫描发现的依赖。
               *
               * 后续 prepareKnownDeps 会基于这份统一清单生成本轮 runOptimizeDeps 的输入。
               */
              for (const id of Object.keys(deps)) {
                if (!metadata.discovered[id]) {
                  addMissingDep(id, deps[id])
                }
              }

              const knownDeps = prepareKnownDeps()
              startNextDiscoveredBatch()

              /**
               * 根据当前已知依赖启动首次预构建。
               *
               * 注意 runOptimizeDeps 这里只生成“候选结果”：产物先写进临时目录，
               * 是否 commit 成正式缓存，要等 onCrawlEnd 比较 scanDeps 和 crawlDeps 后决定。
               */
              optimizationResult = runOptimizeDeps(environment, knownDeps)

              // holdUntilCrawlEnd=true 时，一定等 onCrawlEnd 统一判断是否提交或重跑。
              if (!holdUntilCrawlEnd) {
                // holdUntilCrawlEnd=false 时，扫描预构建结果完成后可先放行；
                // 如果后续 crawl 又发现漏依赖，再走补构建，必要时触发 full reload。
                optimizationResult.result.then((result) => {
                  // 如果首轮 crawl 已经结束，则结果会由 onCrawlEnd 负责处理。
                  if (!waitingForCrawlEnd) return

                  optimizationResult = undefined // signal that we'll be using the result

                  runOptimizer(result)
                })
              }
            } catch (e) {
              logger.error(e.stack || e.message)
            } finally {
              resolve()
              depsOptimizer.scanProcessing = undefined
            }
          })()
        })
      }
    }
  }

  function startNextDiscoveredBatch() {
    newDepsDiscovered = false

    // Add the current depOptimizationProcessing to the queue, these
    // promises are going to be resolved once a rerun is committed
    depOptimizationProcessingQueue.push(depOptimizationProcessing)

    // Create a new promise for the next rerun, discovered missing
    // dependencies will be assigned this promise from this point
    depOptimizationProcessing = promiseWithResolvers()
  }

  function prepareKnownDeps() {
    const knownDeps: Record<string, OptimizedDepInfo> = {}
    // Clone optimized info objects, fileHash, browserHash may be changed for them
    const metadata = depsOptimizer.metadata!
    for (const dep of Object.keys(metadata.optimized)) {
      knownDeps[dep] = { ...metadata.optimized[dep] }
    }
    for (const dep of Object.keys(metadata.discovered)) {
      // Clone the discovered info discarding its processing promise
      const { processing, ...info } = metadata.discovered[dep]
      knownDeps[dep] = info
    }
    return knownDeps
  }

  /**
   * 执行并提交一轮依赖预构建。
   *
   * runOptimizer 不负责“发现依赖”。它消费当前 metadata.discovered：
   * - 没有 preRunResult 时，先 prepareKnownDeps() 生成本轮 runOptimizeDeps 输入；
   * - 有 preRunResult 时，说明后台 scan 已经产出候选结果，这里只负责校验并提交；
   * - commit 成功后更新正式 metadata，并根据产物变化决定是否需要 full reload。
   */
  async function runOptimizer(preRunResult?: DepOptimizationResult) {
    // a successful completion of the optimizeDeps rerun will end up
    // creating new bundled version of all current and discovered deps
    // in the cache dir and a new metadata info object assigned
    // to _metadata. A fullReload is only issued if the previous bundled
    // dependencies have changed.

    // if the rerun fails, _metadata remains untouched, current discovered
    // deps are cleaned, and a fullReload is issued

    // All deps, previous known and newly discovered are rebundled,
    // respect insertion order to keep the metadata file stable

    const isRerun = firstRunCalled
    firstRunCalled = true

    // Ensure that rerun is called sequentially
    enqueuedRerun = undefined

    // Ensure that a rerun will not be issued for current discovered deps
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle)

    if (closed) {
      currentlyProcessing = false
      depOptimizationProcessing.resolve()
      resolveEnqueuedProcessingPromises()
      return
    }

    currentlyProcessing = true

    try {
      let processingResult: DepOptimizationResult
      if (preRunResult) {
        processingResult = preRunResult
      } else {
        const knownDeps = prepareKnownDeps()
        startNextDiscoveredBatch()

        optimizationResult = runOptimizeDeps(environment, knownDeps)
        processingResult = await optimizationResult.result
        optimizationResult = undefined
      }

      if (closed) {
        currentlyProcessing = false
        processingResult.cancel()
        resolveEnqueuedProcessingPromises()
        return
      }

      const newData = processingResult.metadata

      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        newData.optimized,
      )

      // After a re-optimization, if the internal bundled chunks change a full page reload
      // is required. If the files are stable, we can avoid the reload that is expensive
      // for large applications. Comparing their fileHash we can find out if it is safe to
      // keep the current browser state.
      /**
       * 只有浏览器已加载的依赖产物语义可能变了，才需要 full reload。
       * 如果只是补发现新依赖且旧产物稳定，就保留 browserHash，避免打断当前页面状态。
       */
      const needsReload = // 🔖断点[小册04] 重新预构建后是否需要整页刷新(interop 变化/hash 变化/fileHash 变化)
        needsInteropMismatch.length > 0 ||
        metadata.hash !== newData.hash ||
        Object.keys(metadata.optimized).some((dep) => {
          return (
            metadata.optimized[dep].fileHash !== newData.optimized[dep].fileHash
          )
        })

      const commitProcessing = async () => {
        await processingResult.commit()

        // While optimizeDeps is running, new missing deps may be discovered,
        // in which case they will keep being added to metadata.discovered
        for (const id in metadata.discovered) {
          if (!newData.optimized[id]) {
            addOptimizedDepInfo(newData, 'discovered', metadata.discovered[id])
          }
        }

        // If we don't reload the page, we need to keep browserHash stable
        if (!needsReload) {
          newData.browserHash = metadata.browserHash
          for (const dep in newData.chunks) {
            newData.chunks[dep].browserHash = metadata.browserHash
          }
          for (const dep in newData.optimized) {
            newData.optimized[dep].browserHash = (
              metadata.optimized[dep] || metadata.discovered[dep]
            ).browserHash
          }
        }

        // Commit hash and needsInterop changes to the discovered deps info
        // object. Allow for code to await for the discovered processing promise
        // and use the information in the same object
        for (const o in newData.optimized) {
          const discovered = metadata.discovered[o]
          if (discovered) {
            const optimized = newData.optimized[o]
            discovered.browserHash = optimized.browserHash
            discovered.fileHash = optimized.fileHash
            discovered.needsInterop = optimized.needsInterop
            discovered.processing = undefined
          }
        }

        if (isRerun) {
          newDepsToLog.push(
            ...Object.keys(newData.optimized).filter(
              (dep) => !metadata.optimized[dep],
            ),
          )
        }

        metadata = depsOptimizer.metadata = newData
        resolveEnqueuedProcessingPromises()
      }

      if (!needsReload) {
        await commitProcessing()

        if (!debug) {
          if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
          newDepsToLogHandle = setTimeout(() => {
            newDepsToLogHandle = undefined
            logNewlyDiscoveredDeps()
            if (warnAboutMissedDependencies) {
              logDiscoveredDepsWhileScanning()
              logger.info(
                colors.magenta(
                  `❗ add these dependencies to optimizeDeps.include to speed up cold start`,
                ),
                { timestamp: true },
              )
              warnAboutMissedDependencies = false
            }
          }, 2 * debounceMs)
        } else {
          debug(
            colors.green(
              `✨ ${
                !isRerun
                  ? `dependencies optimized`
                  : `optimized dependencies unchanged`
              }`,
            ),
          )
        }
      } else {
        if (newDepsDiscovered) {
          // There are newly discovered deps, and another rerun is about to be
          // executed. Avoid the current full reload discarding this rerun result
          // We don't resolve the processing promise, as they will be resolved
          // once a rerun is committed
          processingResult.cancel()

          debug?.(
            colors.green(
              `✨ delaying reload as new dependencies have been found...`,
            ),
          )
        } else {
          await commitProcessing()

          if (!debug) {
            if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
            newDepsToLogHandle = undefined
            logNewlyDiscoveredDeps()
            if (warnAboutMissedDependencies) {
              logDiscoveredDepsWhileScanning()
              logger.info(
                colors.magenta(
                  `❗ add these dependencies to optimizeDeps.include to avoid a full page reload during cold start`,
                ),
                { timestamp: true },
              )
              warnAboutMissedDependencies = false
            }
          }

          logger.info(
            colors.green(`✨ optimized dependencies changed. reloading`),
            {
              timestamp: true,
            },
          )
          if (needsInteropMismatch.length > 0) {
            logger.warn(
              `Mixed ESM and CJS detected in ${colors.yellow(
                needsInteropMismatch.join(', '),
              )}, add ${
                needsInteropMismatch.length === 1 ? 'it' : 'them'
              } to optimizeDeps.needsInterop to speed up cold start`,
              {
                timestamp: true,
              },
            )
          }

          fullReload()
        }
      }
    } catch (e) {
      logger.error(
        colors.red(`error while updating dependencies:\n${e.stack}`),
        { timestamp: true, error: e },
      )
      resolveEnqueuedProcessingPromises()

      // Reset missing deps, let the server rediscover the dependencies
      metadata.discovered = {}
    }

    currentlyProcessing = false
    // @ts-expect-error `enqueuedRerun` could exist because `debouncedProcessing` may run while awaited
    enqueuedRerun?.()
  }

  function fullReload() {
    // Cached transform results have stale imports (resolved to
    // old locations) so they need to be invalidated before the page is
    // reloaded.
    environment.moduleGraph.invalidateAll()

    environment.hot.send({
      type: 'full-reload',
      path: '*',
    })
  }

  function rerun() {
    // debounce time to wait for new missing deps finished, issue a new
    // optimization of deps (both old and newly found) once the previous
    // optimizeDeps processing is finished
    const deps = Object.keys(metadata.discovered)
    const depsString = depsLogString(deps)
    debug?.(colors.green(`new dependencies found: ${depsString}`))
    runOptimizer()
  }

  function getDiscoveredBrowserHash(
    hash: string,
    deps: Record<string, string>,
    missing: Record<string, string>,
  ) {
    return getHash(
      hash + JSON.stringify(deps) + JSON.stringify(missing) + sessionTimestamp,
    )
  }

  function registerMissingImport( // 🔖断点[小册04] 运行时发现未预构建的依赖→标记+(非冷启动则)防抖触发重建
    id: string,
    resolved: string,
  ): OptimizedDepInfo {
    const optimized = metadata.optimized[id]
    if (optimized) {
      return optimized
    }
    const chunk = metadata.chunks[id]
    if (chunk) {
      return chunk
    }
    let missing = metadata.discovered[id]
    if (missing) {
      // We are already discover this dependency
      // It will be processed in the next rerun call
      return missing
    }

    // 这里先登记 discovered，并立即返回未来产物路径；真正打包会被合并进下一轮优化。
    // 如果还处在首轮 crawl，先不立刻重跑，等 onCrawlEnd 统一和后台 scan 结果比较后再决定。
    missing = addMissingDep(id, resolved)

    // Until the first optimize run is called, avoid triggering processing
    // We'll wait until the user codebase is eagerly processed by Vite so
    // we can get a list of every missing dependency before giving to the
    // browser a dependency that may be outdated, thus avoiding full page reloads

    if (!waitingForCrawlEnd) {
      // Debounced rerun, let other missing dependencies be discovered before
      // the running next optimizeDeps
      debouncedProcessing()
    }

    // Return the path for the optimized bundle, this path is known before
    // esbuild is run to generate the pre-bundle
    return missing // 小册说明：Vite 8 实际由 Rolldown 生成预构建产物；路径可提前返回，是因为它由依赖 id 稳定推导。
  }

  function addMissingDep(id: string, resolved: string) {
    newDepsDiscovered = true

    return addOptimizedDepInfo(metadata, 'discovered', {
      id,
      file: getOptimizedDepPath(environment, id),
      src: resolved,
      // Adding a browserHash to this missing dependency that is unique to
      // the current state of known + missing deps. If its optimizeDeps run
      // doesn't alter the bundled files of previous known dependencies,
      // we don't need a full reload and this browserHash will be kept
      browserHash: getDiscoveredBrowserHash(
        metadata.hash,
        depsFromOptimizedDepInfo(metadata.optimized),
        depsFromOptimizedDepInfo(metadata.discovered),
      ),
      // loading of this pre-bundled dep needs to await for its processing
      // promise to be resolved
      processing: depOptimizationProcessing.promise,
      exportsData: extractExportsData(environment, resolved),
    })
  }

  function debouncedProcessing(timeout = debounceMs) {
    // Debounced rerun, let other missing dependencies be discovered before
    // the next optimizeDeps run
    enqueuedRerun = undefined
    if (debounceProcessingHandle) clearTimeout(debounceProcessingHandle)
    if (newDepsToLogHandle) clearTimeout(newDepsToLogHandle)
    newDepsToLogHandle = undefined
    debounceProcessingHandle = setTimeout(() => {
      debounceProcessingHandle = undefined
      enqueuedRerun = rerun
      if (!currentlyProcessing) {
        enqueuedRerun()
      }
    }, timeout)
  }

  // onCrawlEnd is called once when the server starts and all static
  // imports after the first request have been crawled (dynamic imports may also
  // be crawled if the browser requests them right away).
  async function onCrawlEnd() { // 🔖断点[小册04] 首轮静态 import crawl 结束：比较扫描结果与运行时发现结果，决定提交还是重跑
    /**
     * 核心逻辑：冷启动时 scan 和浏览器触发的源码 crawl 是并行的。
     * crawl 结束后要比较“扫描发现的依赖”和“真实请求发现的依赖”，决定直接提交扫描结果还是合并后重跑优化。
     */
    // switch after this point to a simple debounce strategy
    waitingForCrawlEnd = false

    debug?.(colors.green(`✨ static imports crawl ended`))
    if (closed) {
      return
    }

    // Await for the scan+optimize step running in the background
    // It normally should be over by the time crawling of user code ended
    await depsOptimizer.scanProcessing

    if (optimizationResult && !options.noDiscovery) {
      // In the holdUntilCrawlEnd strategy, we don't release the result of the
      // post-scanner optimize step to the browser until we reach this point
      // If there are new dependencies, we do another optimize run, if not, we
      // use the post-scanner optimize result
      // If holdUntilCrawlEnd is false and we reach here, it means that the
      // scan+optimize step finished after crawl end. We follow the same
      // process as in the holdUntilCrawlEnd in this case.
      const afterScanResult = optimizationResult.result
      optimizationResult = undefined // signal that we'll be using the result

      const result = await afterScanResult
      currentlyProcessing = false

      const crawlDeps = Object.keys(metadata.discovered)
      const scanDeps = Object.keys(result.metadata.optimized)

      if (scanDeps.length === 0 && crawlDeps.length === 0) {
        debug?.(
          colors.green(
            `✨ no dependencies found by the scanner or crawling static imports`,
          ),
        )
        // We still commit the result so the scanner isn't run on the next cold start
        // for projects without dependencies
        startNextDiscoveredBatch()
        runOptimizer(result)
        return
      }

      const needsInteropMismatch = findInteropMismatches(
        metadata.discovered,
        result.metadata.optimized,
      )
      const scannerMissedDeps = crawlDeps.some((dep) => !scanDeps.includes(dep))
      const outdatedResult =
        needsInteropMismatch.length > 0 || scannerMissedDeps

      if (outdatedResult) {
        /**
         * 核心逻辑：如果扫描漏了 crawl 发现的依赖，或者 interop 判断不一致，
         * 直接放行扫描结果会导致浏览器很快 full reload；这里丢弃结果并重跑一次，优先换启动稳定性。
         */
        // Drop this scan result, and perform a new optimization to avoid a full reload
        result.cancel()

        // Add deps found by the scanner to the discovered deps while crawling
        for (const dep of scanDeps) {
          if (!crawlDeps.includes(dep)) {
            addMissingDep(dep, result.metadata.optimized[dep].src!)
          }
        }
        if (scannerMissedDeps) {
          debug?.(
            colors.yellow(
              `✨ new dependencies were found while crawling that weren't detected by the scanner`,
            ),
          )
        }
        debug?.(colors.green(`✨ re-running optimizer`))
        debouncedProcessing(0)
      } else {
        debug?.(
          colors.green(
            `✨ using post-scan optimizer result, the scanner found every used dependency`,
          ),
        )
        startNextDiscoveredBatch()
        runOptimizer(result)
      }
    } else if (!holdUntilCrawlEnd) {
      // The post-scanner optimize result has been released to the browser
      // If new deps have been discovered, issue a regular rerun of the
      // optimizer. A full page reload may still be avoided if the new
      // optimize result is compatible in this case
      if (newDepsDiscovered) {
        debug?.(
          colors.green(
            `✨ new dependencies were found while crawling static imports, re-running optimizer`,
          ),
        )
        warnAboutMissedDependencies = true
        debouncedProcessing(0)
      }
    } else {
      const crawlDeps = Object.keys(metadata.discovered)
      currentlyProcessing = false

      if (crawlDeps.length === 0) {
        debug?.(
          colors.green(
            `✨ no dependencies found while crawling the static imports`,
          ),
        )
        firstRunCalled = true
      }

      // queue the first optimizer run, even without deps so the result is cached
      debouncedProcessing(0)
    }
  }

  return depsOptimizer
}

export function createExplicitDepsOptimizer(
  environment: DevEnvironment,
): DepsOptimizer {
  /**
   * 显式模式（optimizeDeps.noDiscovery=true）的环境级 optimizer。
   *
   * init 直接进入 optimizeExplicitEnvironmentDeps，只展开 optimizeDeps.include；
   * 不启动 discoverProjectDependencies，也不支持 registerMissingImport 动态补充。
   * 因此 CJS 等必须预构建的依赖需要由用户明确写进 include。
   */
  const depsOptimizer = {
    metadata: initDepsOptimizerMetadata(environment),
    isOptimizedDepFile: createIsOptimizedDepFile(environment),
    isOptimizedDepUrl: createIsOptimizedDepUrl(environment),
    getOptimizedDepId: (depInfo: OptimizedDepInfo) =>
      `${depInfo.file}?v=${depInfo.browserHash}`,

    registerMissingImport: () => {
      throw new Error(
        `Vite Internal Error: registerMissingImport is not supported in dev ${environment.name}`,
      )
    },
    init,
    // noop, there is no scanning during dev SSR
    // the optimizer blocks the server start
    run: () => {},

    close: async () => {},
    options: environment.config.optimizeDeps,
  }

  let inited = false
  async function init() {
    if (inited) return
    inited = true

    depsOptimizer.metadata = await optimizeExplicitEnvironmentDeps(environment)
  }

  return depsOptimizer
}

function findInteropMismatches(
  discovered: Record<string, OptimizedDepInfo>,
  optimized: Record<string, OptimizedDepInfo>,
) {
  const needsInteropMismatch = []
  for (const dep in discovered) {
    const discoveredDepInfo = discovered[dep]
    if (discoveredDepInfo.needsInterop === undefined) continue

    const depInfo = optimized[dep]
    if (!depInfo) continue

    if (depInfo.needsInterop !== discoveredDepInfo.needsInterop) {
      // This only happens when a discovered dependency has mixed ESM and CJS syntax
      // and it hasn't been manually added to optimizeDeps.needsInterop
      needsInteropMismatch.push(dep)
      debug?.(colors.cyan(`✨ needsInterop mismatch detected for ${dep}`))
    }
  }
  return needsInteropMismatch
}
