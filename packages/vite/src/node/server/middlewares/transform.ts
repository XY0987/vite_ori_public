import path from 'node:path'
import fsp from 'node:fs/promises'
import colors from 'picocolors'
import type { ExistingRawSourceMap } from 'rolldown'
import type { Connect } from '#dep-types/connect'
import type { ViteDevServer } from '..'
import {
  createDebugger,
  fsPathFromId,
  injectQuery,
  isCSSRequest,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
} from '../../utils'
import { send } from '../send'
import { ERR_DENIED_ID, ERR_LOAD_URL } from '../transformRequest'
import { applySourcemapIgnoreList } from '../sourcemap'
import { isHTMLProxy } from '../../plugins/html'
import {
  DEP_VERSION_RE,
  ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR,
  ERR_OPTIMIZE_DEPS_PROCESSING_ERROR,
  FS_PREFIX,
} from '../../constants'
import { isDirectCSSRequest, isDirectRequest } from '../../plugins/css'
import { ERR_CLOSED_SERVER } from '../pluginContainer'
import { cleanUrl, unwrapId, withTrailingSlash } from '../../../shared/utils'
import {
  ERR_OUTDATED_OPTIMIZED_DEP,
  NULL_BYTE_PLACEHOLDER,
} from '../../../shared/constants'
import type { ResolvedConfig } from '../../config'
import { checkLoadingAccess, respondWithAccessDenied } from './static'

const debugCache = createDebugger('vite:cache')

const knownIgnoreList = new Set(['/', '/favicon.ico'])

const documentFetchDests = new Set([
  'document',
  'iframe',
  'frame',
  'fencedframe',
])
function isDocumentFetchDest(req: Connect.IncomingMessage) {
  const fetchDest = req.headers['sec-fetch-dest']
  return fetchDest !== undefined && documentFetchDests.has(fetchDest)
}

// TODO: consolidate this regex pattern with the url, raw, and inline checks in plugins
const urlRE = /[?&]url\b/
const rawRE = /[?&]raw\b/
const inlineRE = /[?&]inline\b/
const svgRE = /\.svg\b/

export function isServerAccessDeniedForTransform(
  config: ResolvedConfig,
  id: string,
): boolean {
  if (rawRE.test(id) || urlRE.test(id) || inlineRE.test(id) || svgRE.test(id)) {
    return (
      checkLoadingAccess(config, cleanUrl(id)) !== 'allowed' ||
      checkLoadingAccess(config, id) !== 'allowed'
    )
  }
  return false
}

/**
 * A middleware that short-circuits the middleware chain to serve cached transformed modules
 */
export function cachedTransformMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteCachedTransformMiddleware(req, res, next) {
    const environment = server.environments.client

    if (isDocumentFetchDest(req)) {
      res.appendHeader('Vary', 'Sec-Fetch-Dest')
      return next()
    }

    /**
     * 核心逻辑：cachedTransformMiddleware 在真正 transform 前用 moduleGraph 的 etag 快速返回 304。
     * CSS direct/import 可能共享同一文件但响应形态不同，所以 CSS 请求故意不走这条快速路径。
     */
    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch) {
      const moduleByEtag = environment.moduleGraph.getModuleByEtag(ifNoneMatch)
      if (
        moduleByEtag?.transformResult?.etag === ifNoneMatch &&
        moduleByEtag.url === req.url
      ) {
        // For CSS requests, if the same CSS file is imported in a module,
        // the browser sends the request for the direct CSS request with the etag
        // from the imported CSS module. We ignore the etag in this case.
        const maybeMixedEtag = isCSSRequest(req.url!)
        if (!maybeMixedEtag) {
          debugCache?.(`[304] ${prettifyUrl(req.url!, server.config.root)}`)
          res.statusCode = 304
          return res.end()
        }
      }
    }

    next()
  }
}

export function transformMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`

  // check if public dir is inside root dir
  const { root, publicDir } = server.config
  const publicDirInRoot = publicDir.startsWith(withTrailingSlash(root))
  const publicPath = `${publicDir.slice(root.length)}/`

  return async function viteTransformMiddleware(req, res, next) {
    const environment = server.environments.client

    /**
     * transform 中间件只处理类似模块请求的 GET/HEAD。
     * 文档导航、已知忽略路径和非幂等请求交给 HTML fallback、静态资源、
     * 代理或后续中间件处理。
     */
    if (
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      knownIgnoreList.has(req.url!) ||
      isDocumentFetchDest(req)
    ) {
      return next()
    }

    let url: string
    try {
      /**
       * 先把请求 URL 规范化成 moduleGraph 使用的形态。
       * 时间戳 query 只是缓存破坏参数；还原 null byte 是为了让虚拟模块 id
       * 仍然能进入插件管线。
       */
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        '\0',
      )
    } catch (e) {
      if (e instanceof URIError) {
        server.config.logger.warn(
          colors.yellow(
            `Malformed URI sequence in request URL: ${removeTimestampQuery(req.url!)}`,
          ),
        )
        return next()
      }
      return next(e)
    }

    const withoutQuery = cleanUrl(url)

    try {
      const isSourceMap = withoutQuery.endsWith('.map')
      // since we generate source map references, handle those requests here
      if (isSourceMap) {
        const depsOptimizer = environment.depsOptimizer
        if (depsOptimizer?.isOptimizedDepUrl(url)) {
          /**
           * 优化依赖的 sourcemap 和预构建产物一起落在磁盘上。
           * 这里先确认解析后的路径仍然属于 optimizer 输出目录，再直接读取返回。
           */
          // If the browser is requesting a source map for an optimized dep, it
          // means that the dependency has already been pre-bundled and loaded
          const sourcemapPath = url.startsWith(FS_PREFIX)
            ? fsPathFromId(url)
            : normalizePath(path.resolve(server.config.root, url.slice(1)))
          // url may contain relative path that may resolve outside of the optimized deps directory
          if (!depsOptimizer.isOptimizedDepFile(sourcemapPath)) {
            return next()
          }
          try {
            const map = JSON.parse(
              await fsp.readFile(sourcemapPath, 'utf-8'),
            ) as ExistingRawSourceMap

            applySourcemapIgnoreList(
              map,
              sourcemapPath,
              server.config.server.sourcemapIgnoreList,
              server.config.logger,
            )

            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers,
            })
          } catch {
            // Outdated source map request for optimized deps, this isn't an error
            // but part of the normal flow when re-optimizing after missing deps
            // Send back an empty source map so the browser doesn't issue warnings
            const dummySourceMap = {
              version: 3,
              file: sourcemapPath.replace(/\.map$/, ''),
              sources: [],
              sourcesContent: [],
              names: [],
              mappings: ';;;;;;;;;',
            }
            return send(req, res, JSON.stringify(dummySourceMap), 'json', {
              cacheControl: 'no-cache',
              headers: server.config.server.headers,
            })
          }
        } else {
          /**
           * 普通源码模块的 sourcemap 不写入磁盘，而是跟 transformResult
           * 一起保存在 moduleGraph 里。
           */
          const originalUrl = url.replace(/\.map($|\?)/, '$1')
          const map = (
            await environment.moduleGraph.getModuleByUrl(originalUrl)
          )?.transformResult?.map
          if (map) {
            return send(req, res, JSON.stringify(map), 'json', {
              headers: server.config.server.headers,
            })
          } else {
            return next()
          }
        }
      }

      /**
       * dev 下虽然可以写 `/public/foo.png`，但 public 目录实际挂载在服务根路径。
       * 这里提前提示用户改成生产环境也成立的引用方式。
       */
      if (publicDirInRoot && url.startsWith(publicPath)) {
        warnAboutExplicitPublicPathInUrl(url)
      }

      /**
       * 只有类似模块的请求才进入 transform 管线；其他 URL 会继续流到后面的
       * raw fs、static 或 HTML 中间件。
       */
      if (
        req.headers['sec-fetch-dest'] === 'script' ||
        isJSRequest(url) ||
        isImportRequest(url) ||
        isCSSRequest(url) ||
        isHTMLProxy(url)
      ) {
        // strip ?import
        url = removeImportQuery(url)
        // Strip valid id prefix. This is prepended to resolved Ids that are
        // not valid browser import specifiers by the importAnalysis plugin.
        url = unwrapId(url)

        /**
         * 核心逻辑：同一个 CSS 文件可能以 JS import 或浏览器 link 两种方式进入。
         * link 请求必须拿到真实 CSS，所以这里注入 ?direct，把它和“CSS 转 JS 模块”的路径区分开。
         */
        // for CSS, we differentiate between normal CSS requests and imports
        if (isCSSRequest(url)) {
          if (
            req.headers.accept?.includes('text/css') &&
            !isDirectRequest(url)
          ) {
            url = injectQuery(url, 'direct')
          }

          // check if we can return 304 early for CSS requests. These aren't handled
          // by the cachedTransformMiddleware due to the browser possibly mixing the
          // etags of direct and imported CSS
          const ifNoneMatch = req.headers['if-none-match']
          if (
            ifNoneMatch &&
            (await environment.moduleGraph.getModuleByUrl(url))?.transformResult
              ?.etag === ifNoneMatch
          ) {
            debugCache?.(`[304] ${prettifyUrl(url, server.config.root)}`)
            res.statusCode = 304
            return res.end()
          }
        }

        /**
         * 核心逻辑：走到这里的请求才进入按需编译。
         * transformRequest 会完成 resolve -> load -> transform，并把结果交给 send 统一设置缓存头和 sourcemap。
         */
        const result = await environment.transformRequest(url) // 🔖断点[小册05] 中间件→转换管线的交接点(按需编译一个模块从这里开始)
        if (result) {
          const depsOptimizer = environment.depsOptimizer
          const type = isDirectCSSRequest(url) ? 'css' : 'js'
          const isDep =
            DEP_VERSION_RE.test(url) || depsOptimizer?.isOptimizedDepUrl(url)
          return send(req, res, result.code, type, {
            etag: result.etag,
            // allow browser to cache npm deps!
            cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache',
            headers: server.config.server.headers,
            map: result.map,
          })
        }
      }
    } catch (e) {
      if (e?.code === ERR_OPTIMIZE_DEPS_PROCESSING_ERROR) {
        /**
         * optimizer 还在生成当前请求的依赖产物。
         * 这里让浏览器认为本次请求超时，后续刷新或重试会命中生成好的优化文件。
         */
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Optimize Deps Processing Error'
          res.end()
        }
        // This timeout is unexpected
        server.config.logger.error(e.message)
        return
      }
      if (e?.code === ERR_OUTDATED_OPTIMIZED_DEP) {
        /**
         * 新一轮依赖扫描发现了不同的优化依赖图。
         * 当前请求指向的是过期预构建产物，应该直接放弃。
         */
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Outdated Optimize Dep'
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      if (e?.code === ERR_CLOSED_SERVER) {
        /**
         * server 重启或恢复期间，正在进行的 transform 请求可能撞上旧 server 关闭。
         * 这类请求按过期请求处理，避免在终端暴露干扰性的错误。
         */
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 504 // status code request timeout
          res.statusMessage = 'Outdated Request'
          res.end()
        }
        // We don't need to log an error in this case, the request
        // is outdated because new dependencies were discovered and
        // the new pre-bundle dependencies have changed.
        // A full-page reload has been issued, and these old requests
        // can't be properly fulfilled. This isn't an unexpected
        // error but a normal part of the missing deps discovery flow
        return
      }
      if (e?.code === ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR) {
        /**
         * 浏览器请求了一个理论上应该存在于 optimizer 输出目录的文件。
         * 返回 404 并打印 warn，因为这通常说明依赖缓存已在本次请求期间发生变化。
         */
        // Skip if response has already been sent
        if (!res.writableEnded) {
          res.statusCode = 404
          res.end()
        }
        server.config.logger.warn(colors.yellow(e.message))
        return
      }
      if (e?.code === ERR_LOAD_URL) {
        // Let other middleware handle if we can't load the url via transformRequest
        return next()
      }
      if (e?.code === ERR_DENIED_ID) {
        /**
         * transform 的文件访问检查和静态资源服务的访问检查需要先对齐。
         * 如果后面的静态资源中间件仍可能处理，就不要在这里提前返回拒绝页。
         */
        const id: string = e.id
        let servingAccessResult = checkLoadingAccess(
          server.config,
          cleanUrl(id),
        )
        if (servingAccessResult === 'allowed') {
          servingAccessResult = checkLoadingAccess(server.config, id)
        }
        if (servingAccessResult === 'denied') {
          respondWithAccessDenied(id, server, res)
          return true
        }
        if (servingAccessResult === 'fallback') {
          next()
          return true
        }
        servingAccessResult satisfies 'allowed'
        throw new Error(`Unexpected access result for id ${id}`)
      }
      return next(e)
    }

    next()
  }

  function warnAboutExplicitPublicPathInUrl(url: string) {
    let warning: string

    /**
     * JS import 和普通资源 URL 的修复方式不同，所以提示文案也不同：
     * 被 import 的资源应该放进 src；public 资源则应该从服务根路径引用。
     */
    if (isImportRequest(url)) {
      const rawUrl = removeImportQuery(url)
      if (urlRE.test(url)) {
        warning =
          `Assets in the public directory are served at the root path.\n` +
          `Instead of ${colors.cyan(rawUrl)}, use ${colors.cyan(
            rawUrl.replace(publicPath, '/'),
          )}.`
      } else {
        warning =
          'Assets in public directory cannot be imported from JavaScript.\n' +
          `If you intend to import that asset, put the file in the src directory, and use ${colors.cyan(
            rawUrl.replace(publicPath, '/src/'),
          )} instead of ${colors.cyan(rawUrl)}.\n` +
          `If you intend to use the URL of that asset, use ${colors.cyan(
            injectQuery(rawUrl.replace(publicPath, '/'), 'url'),
          )}.`
      }
    } else {
      warning =
        `Files in the public directory are served at the root path.\n` +
        `Instead of ${colors.cyan(url)}, use ${colors.cyan(
          url.replace(publicPath, '/'),
        )}.`
    }

    server.config.logger.warn(colors.yellow(warning))
  }
}
