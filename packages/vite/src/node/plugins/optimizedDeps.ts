import fsp from 'node:fs/promises'
import colors from 'picocolors'
import type { DevEnvironment } from '..'
import type { Plugin } from '../plugin'
import {
  DEP_VERSION_RE,
  ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR,
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
} from '../constants'
import { createDebugger } from '../utils'
import {
  isDepOptimizationDisabled,
  optimizedDepInfoFromFile,
} from '../optimizer'
import { cleanUrl } from '../../shared/utils'
import { ERR_OUTDATED_OPTIMIZED_DEP } from '../../shared/constants'

const debug = createDebugger('vite:optimize-deps')

/**
 * 这是预构建产物的请求消费端，不是启动扫描和打包的生产端。
 * depsOptimizer 由 DevEnvironment 持有，并在 environment.listen() 中 init；
 * 本插件只在后续 resolveId/load 阶段识别、等待并读取 depsOptimizer 生成的文件。
 */
export function optimizedDepsPlugin(): Plugin {
  return {
    name: 'vite:optimized-deps',

    applyToEnvironment(environment) {
      if (environment.config.isBundled) {
        return false
      }
      return !isDepOptimizationDisabled(environment.config.optimizeDeps)
    },

    resolveId(id) {
      const environment = this.environment as DevEnvironment
      if (environment.depsOptimizer?.isOptimizedDepFile(id)) {
        return id
      }
    },

    // this.load({ id }) isn't implemented in PluginContainer
    // The logic to register an id to wait until it is processed
    // is in importAnalysis, see call to delayDepsOptimizerUntil

    /**
     * 这是“浏览器请求预构建资源”和“depsOptimizer 后台产物”之间的交接点：
     *
     * transformMiddleware -> pluginContainer.load(id)
     *   -> vite:optimized-deps.load(id)
     *   -> 查 metadata / 等待 processing / 读取 node_modules/.vite/deps 文件
     *
     * load 不负责发现或打包依赖；它负责保证请求只能读取当前版本且已经写完的产物，
     * 从而处理“请求已到达，但后台预构建仍未结束”这类并发情况。
     */
    async load(id) {
      const environment = this.environment as DevEnvironment
      const depsOptimizer = environment.depsOptimizer
      if (depsOptimizer?.isOptimizedDepFile(id)) {
        /**
         * 先保存当前 metadata 快照。等待 processing 期间 optimizer 可能重新提交一份
         * metadata，后面需要对比新旧对象，避免把旧批次的文件返回给浏览器。
         */
        const metadata = depsOptimizer.metadata
        // id 可能带 ?v=browserHash；磁盘读取前先清掉 query 得到真实文件路径。
        const file = cleanUrl(id)
        const versionMatch = DEP_VERSION_RE.exec(id)
        // browserHash 标识浏览器当前请求的是哪一批预构建产物。
        const browserHash = versionMatch
          ? versionMatch[1].split('=')[1]
          : undefined

        // 同时从已完成 optimized 和本轮 newly discovered 依赖中查找处理状态。
        const info = optimizedDepInfoFromFile(metadata, file)
        if (info) {
          // 请求携带的版本已经落后时立即终止，让页面刷新后请求最新 URL。
          if (
            browserHash &&
            info.browserHash !== browserHash &&
            !environment.config.optimizeDeps.ignoreOutdatedRequests
          ) {
            throwOutdatedRequest(id)
          }
          try {
            /**
             * 关键等待点：依赖入口可能已经被发现并生成 URL，但文件仍在后台打包。
             * processing resolve 后，才能确定对应文件已经完整写入磁盘。
             */
            await info.processing
          } catch {
            // 后台处理失败或预期中的刷新没有接管请求，转成专用 processing error。
            throwProcessingError(id)
          }
          /**
           * await 期间可能发生二次预构建并替换 metadata。
           * 再查一次 browserHash，防止竞态条件下继续返回已经失效的旧文件。
           */
          const newMetadata = depsOptimizer.metadata
          if (metadata !== newMetadata) {
            const currentInfo = optimizedDepInfoFromFile(newMetadata!, file)
            if (
              info.browserHash !== currentInfo?.browserHash &&
              !environment.config.optimizeDeps.ignoreOutdatedRequests
            ) {
              throwOutdatedRequest(id)
            }
          }
        }
        debug?.(`load ${colors.cyan(file)}`)
        /**
         * processing 完成后直接读取预构建缓存文件，不再交给其它插件的 load hook。
         * 这样既避免其它插件误处理生成物，也避免多个 load hook 与文件提交产生竞态。
         * sourcemap 存在就与代码一起返回，不存在则只返回代码。
         */
        try {
          const [code, map] = await Promise.all([
            fsp.readFile(file, 'utf-8'),
            fsp
              .readFile(`${file}.map`, 'utf-8')
              .then((map) => JSON.parse(map))
              .catch(() => null),
          ])
          if (map) {
            return {
              code,
              map,
            }
          }
          return code
        } catch {
          /**
           * 读取失败且请求带 browserHash，通常说明 optimizer 重跑后旧文件已被替换；
           * 此时按过期请求处理。没有版本信息时才报告真正的预构建文件缺失。
           */
          if (
            browserHash &&
            !environment.config.optimizeDeps.ignoreOutdatedRequests
          ) {
            // Outdated optimized files loaded after a rerun
            throwOutdatedRequest(id)
          }
          throwFileNotFoundInOptimizedDep(id)
        }
      }
    },
  }
}

function throwProcessingError(id: string): never {
  const err: any = new Error(
    `Something unexpected happened while optimizing "${id}". ` +
      `The current page should have reloaded by now`,
  )
  err.code = ERR_OPTIMIZE_DEPS_PROCESSING_ERROR
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err
}

export function throwOutdatedRequest(id: string): never {
  const err: any = new Error(
    `There is a new version of the pre-bundle for "${id}", ` +
      `a page reload is going to ask for it.`,
  )
  err.code = ERR_OUTDATED_OPTIMIZED_DEP
  // This error will be caught by the transform middleware that will
  // send a 504 status code request timeout
  throw err
}

export function throwFileNotFoundInOptimizedDep(id: string): never {
  const err: any = new Error(
    `The file does not exist at "${id}" which is in the optimize deps directory. ` +
      `The dependency might be incompatible with the dep optimizer. ` +
      `Try adding it to \`optimizeDeps.exclude\`.`,
  )
  err.code = ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR
  // This error will be caught by the transform middleware that will
  // send a 404 status code not found
  throw err
}
