import path from 'node:path'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import colors from 'picocolors'
import MagicString from 'magic-string'
import type {
  ParseError as EsModuleLexerParseError,
  ExportSpecifier,
  ImportSpecifier,
} from 'es-module-lexer'
import { init, parse as parseImports } from 'es-module-lexer'
import { parseAst } from 'rolldown/parseAst'
import type { StaticImport } from 'mlly'
import { ESM_STATIC_IMPORT_RE, parseStaticImport } from 'mlly'
import { makeLegalIdentifier } from '@rollup/pluginutils'
import type { PartialResolvedId, RollupError } from 'rolldown'
import type { ESTree } from 'rolldown/utils'
import {
  CLIENT_DIR,
  CLIENT_PUBLIC_PATH,
  DEP_VERSION_RE,
  FS_PREFIX,
  SPECIAL_QUERY_RE,
} from '../constants'
import {
  debugHmr,
  handlePrunedModules,
  lexAcceptedHmrDeps,
  lexAcceptedHmrExports,
  normalizeHmrUrl,
} from '../server/hmr'
import {
  createDebugger,
  fsPathFromUrl,
  generateCodeFrame,
  getFileStartIndex,
  getHash,
  injectQuery,
  isBuiltin,
  isCSSRequest,
  isDataUrl,
  isDefined,
  isExternalUrl,
  isFilePathESM,
  isInNodeModules,
  isJSRequest,
  joinUrlSegments,
  moduleListContains,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  stripBase,
  stripBomTag,
  timeFrom,
  transformStableResult,
  urlRE,
} from '../utils'
import { checkPublicFile } from '../publicDir'
import type { ResolvedConfig } from '../config'
import type { Plugin } from '../plugin'
import type { DevEnvironment } from '../server/environment'
import { shouldExternalize } from '../external'
import {
  optimizedDepInfoFromFile,
  optimizedDepNeedsInterop,
} from '../optimizer'
import {
  cleanUrl,
  unwrapId,
  withTrailingSlash,
  wrapId,
} from '../../shared/utils'
import type { TransformPluginContext } from '../server/pluginContainer'
import { throwOutdatedRequest } from './optimizedDeps'
import { isDirectCSSRequest } from './css'
import { browserExternalId } from './resolve'
import { serializeDefine } from './define'
import { WORKER_FILE_ID } from './worker'
import { getAliasPatternMatcher } from './preAlias'

const debug = createDebugger('vite:import-analysis')

const clientDir = normalizePath(CLIENT_DIR)

const skipRE = /\.(?:map|json)(?:$|\?)/
export const canSkipImportAnalysis = (id: string): boolean =>
  skipRE.test(id) || isDirectCSSRequest(id)

const optimizedDepChunkRE = /\/chunk-[A-Z\d]{8}\.js/

export const hasViteIgnoreRE: RegExp = /\/\*\s*@vite-ignore\s*\*\//

const urlIsStringRE = /^(?:'.*'|".*"|`.*`)$/

const templateLiteralRE = /^\s*`(.*)`\s*$/

interface UrlPosition {
  url: string
  start: number
  end: number
}

export function isExplicitImportRequired(url: string): boolean {
  return !isJSRequest(url) && !isCSSRequest(url)
}

function normalizeResolvedIdToUrl(
  environment: DevEnvironment,
  url: string,
  resolved: PartialResolvedId,
): string {
  const root = environment.config.root
  const depsOptimizer = environment.depsOptimizer

  // normalize all imports into resolved URLs
  // e.g. `import 'foo'` -> `import '/@fs/.../node_modules/foo/index.js'`
  if (resolved.id.startsWith(withTrailingSlash(root))) {
    // in root: infer short absolute path from root
    url = resolved.id.slice(root.length)
  } else if (
    depsOptimizer?.isOptimizedDepFile(resolved.id) ||
    // vite-plugin-react isn't following the leading \0 virtual module convention.
    // This is a temporary hack to avoid expensive fs checks for React apps.
    // We'll remove this as soon we're able to fix the react plugins.
    (resolved.id !== '/@react-refresh' &&
      path.isAbsolute(resolved.id) &&
      fs.existsSync(cleanUrl(resolved.id)))
  ) {
    // an optimized deps may not yet exists in the filesystem, or
    // a regular file exists but is out of root: rewrite to absolute /@fs/ paths
    url = path.posix.join(FS_PREFIX, resolved.id)
  } else {
    url = resolved.id
  }

  // if the resolved id is not a valid browser import specifier,
  // prefix it to make it valid. We will strip this before feeding it
  // back into the transform pipeline
  if (url[0] !== '.' && url[0] !== '/') {
    url = wrapId(resolved.id)
  }

  return url
}

function extractImportedBindings(
  id: string,
  source: string,
  importSpec: ImportSpecifier,
  importedBindings: Map<string, Set<string>>,
) {
  let bindings = importedBindings.get(id)
  if (!bindings) {
    bindings = new Set<string>()
    importedBindings.set(id, bindings)
  }

  const isDynamic = importSpec.d > -1
  const isMeta = importSpec.d === -2
  if (isDynamic || isMeta) {
    // this basically means the module will be impacted by any change in its dep
    bindings.add('*')
    return
  }

  const exp = source.slice(importSpec.ss, importSpec.se)
  ESM_STATIC_IMPORT_RE.lastIndex = 0
  const match = ESM_STATIC_IMPORT_RE.exec(exp)
  if (!match) {
    return
  }

  const staticImport: StaticImport = {
    type: 'static',
    code: match[0],
    start: match.index,
    end: match.index + match[0].length,
    imports: match.groups!.imports,
    specifier: match.groups!.specifier,
  }
  const parsed = parseStaticImport(staticImport)
  if (parsed.namespacedImport) {
    bindings.add('*')
  }
  if (parsed.defaultImport) {
    bindings.add('default')
  }
  if (parsed.namedImports) {
    for (const name of Object.keys(parsed.namedImports)) {
      bindings.add(name)
    }
  }
}

/**
 * Dev-only plugin that lexes, resolves, rewrites and analyzes url imports.
 *
 * - Imports are resolved to ensure they exist on disk
 *
 * - Lexes HMR accept calls and updates import relationships in the module graph
 *
 * - Bare module imports are resolved (by @rollup-plugin/node-resolve) to
 * absolute file paths, e.g.
 *
 *     ```js
 *     import 'foo'
 *     ```
 *     is rewritten to
 *     ```js
 *     import '/@fs//project/node_modules/foo/dist/foo.js'
 *     ```
 *
 * - CSS imports are appended with `.js` since both the js module and the actual
 * css (referenced via `<link>`) may go through the transform pipeline:
 *
 *     ```js
 *     import './style.css'
 *     ```
 *     is rewritten to
 *     ```js
 *     import './style.css.js'
 *     ```
 */
export function importAnalysisPlugin(config: ResolvedConfig): Plugin {
  const { root, base } = config
  const clientPublicPath = path.posix.join(base, CLIENT_PUBLIC_PATH)
  const enablePartialAccept = config.experimental.hmrPartialAccept
  const matchAlias = getAliasPatternMatcher(config.resolve.alias)

  let _env: string | undefined
  let _ssrEnv: string | undefined
  function getEnv(ssr: boolean) {
    if (!_ssrEnv || !_env) {
      const importMetaEnvKeys: Record<string, any> = {}
      const userDefineEnv: Record<string, any> = {}
      for (const key in config.env) {
        importMetaEnvKeys[key] = JSON.stringify(config.env[key])
      }
      for (const key in config.define) {
        // non-import.meta.env.* is handled in `clientInjection` plugin
        if (key.startsWith('import.meta.env.')) {
          userDefineEnv[key.slice(16)] = config.define[key]
        }
      }
      const env = `import.meta.env = ${serializeDefine({
        ...importMetaEnvKeys,
        SSR: '__vite_ssr__',
        ...userDefineEnv,
      })};`
      _ssrEnv = env.replace('__vite_ssr__', 'true')
      _env = env.replace('__vite_ssr__', 'false')
    }
    return ssr ? _ssrEnv : _env
  }

  return {
    name: 'vite:import-analysis',

    applyToEnvironment(environment) {
      return !environment.config.isBundled
    },

    async transform(source, importer) {
      const environment = this.environment as DevEnvironment
      const ssr = environment.config.consumer === 'server'
      const moduleGraph = environment.moduleGraph

      if (canSkipImportAnalysis(importer)) {
        debug?.(colors.dim(`[skipped] ${prettifyUrl(importer, root)}`))
        return null
      }

      const msAtStart = debug ? performance.now() : 0
      await init
      let imports!: readonly ImportSpecifier[]
      let exports!: readonly ExportSpecifier[]
      source = stripBomTag(source)
      try {
        /**
         * 核心逻辑：这里用词法扫描而不是完整 AST，目标只是快速拿到 import/export 的位置。
         * 真正的路径解析和字符串改写会在后面的 normalizeUrl + MagicString 阶段完成。
         */
        ;[imports, exports] = parseImports(source) // 🔖断点[小册06] es-module-lexer 词法分析,扫出所有 import/export 位置
      } catch (_e: unknown) {
        const e = _e as EsModuleLexerParseError
        const { message, showCodeFrame } = createParseErrorInfo(
          importer,
          source,
        )
        this.error(message, showCodeFrame ? e.idx : undefined)
      }

      const depsOptimizer = environment.depsOptimizer

      /**
       * 走到 import-analysis.transform 时，当前 importer 已经经过 loadAndTransform 的入图步骤。
       * 所以这里不是创建当前模块，而是拿到当前模块节点，后面用它作为“连边”的起点。
       */
      const importerModule = moduleGraph.getModuleById(importer)
      if (!importerModule) {
        // This request is no longer valid. It could happen for optimized deps
        // requests. A full reload is going to request this id again.
        // Throwing an outdated error so we properly finish the request with a
        // 504 sent to the browser.
        throwOutdatedRequest(importer)
      }

      if (
        !imports.length &&
        !(this as unknown as TransformPluginContext)._addedImports
      ) {
        /**
         * 即使当前源码里没有 import，也要更新一次模块图。
         * 因为上一次 transform 可能记录过依赖边，这次没有 import 意味着旧边需要被清理。
         */
        const prunedImports = await moduleGraph.updateModuleInfo( // 🔖断点[小册06] 无 import 的模块也要更新模块图，清理上次 transform 留下的旧边
          importerModule,
          new Set(),
          null,
          new Set(),
          null,
          false,
        )
        if (prunedImports) {
          handlePrunedModules(prunedImports, environment)
        }
        debug?.(
          `${timeFrom(msAtStart)} ${colors.dim(
            `[no imports] ${prettifyUrl(importer, root)}`,
          )}`,
        )
        return source
      }

      let hasHMR = false
      let isSelfAccepting = false
      let hasEnv = false
      let needQueryInjectHelper = false
      let s: MagicString | undefined
      const str = () => s || (s = new MagicString(source))
      let isPartiallySelfAccepting = false
      const importedBindings = enablePartialAccept
        ? new Map<string, Set<string>>()
        : null

      const normalizeUrl = async (
        url: string,
        pos: number,
        forceSkipImportAnalysis: boolean = false,
      ): Promise<[string, string | null]> => {
        /**
         * normalizeUrl 是 import-analysis 里处理“依赖 URL”的核心小管线。
         * 它不会创建磁盘文件，也不会直接建立 import 依赖边；它做的是：
         * 1. 以当前 importer 为上下文，把源码里的 import 字符串 resolve 成模块 id；
         * 2. 把 resolved id 规范化成浏览器后续真正请求的模块 URL；
         * 3. 调 _ensureEntryFromUrl 确保这个“被依赖模块”在 moduleGraph 中有节点；
         * 4. 返回规范化后的 URL，外层再负责改写源码、收集 importedUrls，并最终交给 updateModuleInfo 连边。
         */
        let importerFile = importer

        if (
          depsOptimizer &&
          moduleListContains(depsOptimizer.options.exclude, url)
        ) {
          /**
           * 核心逻辑：冷启动扫描还没完成时，import analysis 需要等待 scanProcessing。
           * 这样被 exclude 的依赖能基于优化前的真实源码位置重新 resolve，避免从 .vite/deps 目录出发解析错。
           */
          await depsOptimizer.scanProcessing

          // if the dependency encountered in the optimized file was excluded from the optimization
          // the dependency needs to be resolved starting from the original source location of the optimized file
          // because starting from node_modules/.vite will not find the dependency if it was not hoisted
          // (that is, if it is under node_modules directory in the package source of the optimized file)
          for (const optimizedModule of depsOptimizer.metadata.depInfoList) {
            if (!optimizedModule.src) continue // Ignore chunks
            if (optimizedModule.file === importerModule.file) {
              importerFile = optimizedModule.src
            }
          }
        }

        /**
         * 先通过插件容器 resolve，把源码中的裸导入、相对路径或虚拟模块名，
         * 统一解析成 Vite 内部能识别的 resolved id。
         */
        const resolved = await this.resolve(url, importerFile).catch((e) => {
          if (e instanceof Error) {
            ;(e as RollupError).pos ??= pos
          }
          throw e
        })

        // NOTE: resolved.meta is undefined in dev
        if (!resolved || resolved.meta?.['vite:alias']?.noResolved) {
          // in ssr, we should let node handle the missing modules
          if (ssr) {
            return [url, null]
          }
          // fix#9534, prevent the importerModuleNode being stopped from propagating updates
          importerModule.isSelfAccepting = false
          moduleGraph._hasResolveFailedErrorModules.add(importerModule)
          return this.error(
            `Failed to resolve import "${url}" from "${normalizePath(
              path.relative(process.cwd(), importerFile),
            )}". Does the file exist?`,
            pos,
          )
        }

        if (isExternalUrl(resolved.id)) {
          return [resolved.id, resolved.id]
        }

        url = normalizeResolvedIdToUrl(environment, url, resolved)

        try {
          /**
           * 这里处理的是“被 import 的依赖模块”。
           * normalizeUrl 已经拿到了 resolved 结果，所以直接调用内部方法，避免重复 resolve。
           * _ensureEntryFromUrl 只负责为依赖模块创建或复用节点，并登记 url/id/file 索引；
           * 它不会把当前 importer 和依赖模块连成边，真正连边要等扫描结束后交给 updateModuleInfo。
           */
          const depModule = await moduleGraph._ensureEntryFromUrl(
            unwrapId(url),
            canSkipImportAnalysis(url) || forceSkipImportAnalysis,
            resolved,
          )
          // check if the dep has been hmr updated. If yes, we need to attach
          // its last updated timestamp to force the browser to fetch the most
          // up-to-date version of this module.
          if (
            environment.config.consumer === 'client' &&
            depModule.lastHMRTimestamp > 0
          ) {
            url = injectQuery(url, `t=${depModule.lastHMRTimestamp}`)
          }
        } catch (e: any) {
          // it's possible that the dep fails to resolve (non-existent import)
          // attach location to the missing import
          e.pos = pos
          throw e
        }

        // make the URL browser-valid
        if (environment.config.consumer === 'client') {
          const isRelative = url[0] === '.'
          const isSelfImport =
            !isRelative && cleanUrl(url) === cleanUrl(importer)

          // mark non-js/css imports with `?import`
          if (isExplicitImportRequired(url)) {
            url = injectQuery(url, 'import')
          } else if (
            (isRelative || isSelfImport) &&
            !DEP_VERSION_RE.test(url)
          ) {
            // If the url isn't a request for a pre-bundled common chunk,
            // for relative js/css imports, or self-module virtual imports
            // (e.g. vue blocks), inherit importer's version query
            // do not do this for unknown type imports, otherwise the appended
            // query can break 3rd party plugin's extension checks.
            const versionMatch = DEP_VERSION_RE.exec(importer)
            if (versionMatch) {
              url = injectQuery(url, versionMatch[1])
            }
          }
        }

        // prepend base
        if (!ssr) url = joinUrlSegments(base, url)

        return [url, resolved.id]
      }

      /**
       * import 扫描会并发处理，但最终更新模块图和改写源码时仍要保持源码中的顺序。
       * 所以这里用与 imports 等长的数组按 index 存放结果，再在后面统一合并成 Set。
       */
      const orderedImportedUrls = new Array<string | undefined>(imports.length)
      const orderedAcceptedUrls = new Array<Set<UrlPosition> | undefined>(
        imports.length,
      )
      const orderedAcceptedExports = new Array<Set<string> | undefined>(
        imports.length,
      )

      let _isNodeModeResult = config.legacy?.inconsistentCjsInterop
        ? false
        : undefined
      const isNodeMode = () => {
        _isNodeModeResult ??= isFilePathESM(importer, config.packageCache)
        return _isNodeModeResult
      }

      /**
       * 对 es-module-lexer 扫出的每个 import 逐个分析。
       * 这里同时承担三件事：识别 import.meta 特殊语法、resolve/改写普通 import、
       * 收集后续 updateModuleInfo 需要的依赖清单和 HMR accept 信息。
       */
      await Promise.all(
        imports.map(async (importSpecifier, index) => {
          const {
            s: start,
            e: end,
            ss: expStart,
            se: expEnd,
            d: dynamicIndex,
            a: attributeIndex,
          } = importSpecifier

          /**
           * specifier 是源码里“我要导入谁”的那段字符串，还没经过 Vite resolve。
           * 例如：
           * - import foo from './foo.ts' 里的 specifier 是 './foo.ts'；
           * - import { ref } from 'vue' 里的 specifier 是 'vue'；
           * - import('./bar.ts') 里的 specifier 是 './bar.ts'。
           *
           * 后面跳过 external/data url、判断 /public、调用 normalizeUrl、改写浏览器 URL，
           * 都是围绕这个 specifier 展开。这里用 importSpecifier.n 是为了拿到
           * es-module-lexer 处理过的未转义字符串，避免源码里带转义路径时直接 slice 出错。
           */
          let specifier = importSpecifier.n

          const rawUrl = source.slice(start, end)

          /**
           * 先处理 import.meta 这一类“不是依赖导入”的特殊语法。
           * es-module-lexer 会把 import.meta 也扫进 imports 列表，但它不是
           * import './foo' 这种模块 specifier，不能当作依赖 URL 去 resolve。
           *
           * 这里做的事只是打标记和收集信息：
           * - import.meta.hot：说明当前模块使用了 HMR API，后面要注入 hot context；
           * - import.meta.hot.accept(...)：先词法收集 accept 参数里的依赖 URL，
           *   后面再单独 normalize，并写入 HMR 接受关系；
           * - import.meta.env：说明后面要注入环境变量对象。
           */
          if (rawUrl === 'import.meta') {
            const prop = source.slice(end, end + 4)
            if (prop === '.hot') {
              hasHMR = true
              const endHot = end + 4 + (source[end + 4] === '?' ? 1 : 0)
              if (source.slice(endHot, endHot + 7) === '.accept') {
                /**
                 * 继续分析 import.meta.hot.accept 系列调用的参数。
                 * 这里仍然不更新模块图，只把 HMR 边界信息暂存到 orderedAcceptedUrls /
                 * orderedAcceptedExports，等普通 import 扫描完成后统一 normalize 和写图。
                 *
                 * - accept(dep, cb)：表示当前模块能接住某个依赖的更新；
                 * - acceptExports(exports, cb)：表示当前模块能接住自己的部分导出更新；
                 * - accept(cb) / accept()：没有显式依赖参数，表示当前模块自接受。
                 */
                if (source.slice(endHot, endHot + 14) === '.acceptExports') {
                  const importAcceptedExports = (orderedAcceptedExports[index] =
                    new Set<string>())
                  lexAcceptedHmrExports(
                    source,
                    source.indexOf('(', endHot + 14) + 1,
                    importAcceptedExports,
                  )
                  isPartiallySelfAccepting = true
                } else {
                  const importAcceptedUrls = (orderedAcceptedUrls[index] =
                    new Set<UrlPosition>())
                  if (
                    lexAcceptedHmrDeps(
                      source,
                      source.indexOf('(', endHot + 7) + 1,
                      importAcceptedUrls,
                    )
                  ) {
                    isSelfAccepting = true
                  }
                }
              }
            } else if (prop === '.env') {
              hasEnv = true
            }
            return
          } else if (templateLiteralRE.test(rawUrl)) {
            /**
             * 再处理“用了反引号，但目标其实是静态字符串”的 import。
             * 例如 import(`./foo.js`) 语法上是动态 import，但没有 ${} 表达式，
             * Vite 仍然可以静态知道它导入的是 ./foo.js。
             *
             * 这里把模板字符串还原成普通 specifier，让它继续走下面的 normalizeUrl；
             * 真正含有 ${name} 的动态拼接 import 则保留 specifier = undefined，
             * 后面会进入不可静态分析的动态 import 分支。
             */
            if (!(rawUrl.includes('${') && rawUrl.includes('}'))) {
              specifier = rawUrl.replace(templateLiteralRE, '$1')
            }
          }

          const isDynamicImport = dynamicIndex > -1

          /**
           * 静态 import 的 attributes 由 Vite 自己处理，发给浏览器前需要从源码里去掉，
           * 避免不同浏览器对 import attributes 支持不一致。
           */
          if (!isDynamicImport && attributeIndex > -1) {
            str().remove(end + 1, expEnd)
          }

          /**
           * 静态 import 或可解析成字符串的动态 import，会进入 normalizeUrl。
           * normalizeUrl 会完成 resolve、依赖节点入图和浏览器 URL 归一化。
           */
          if (specifier !== undefined) {
            /**
             * 外链、data URI、SSR external 和内建模块不属于 dev server 模块图里的本地模块，
             * 这些导入不需要改写，也不参与 HMR import 链路。
             */
            if (
              ((isExternalUrl(specifier) && !specifier.startsWith('file://')) ||
                isDataUrl(specifier)) &&
              !matchAlias(specifier)
            ) {
              return
            }
            // skip ssr externals and builtins
            if (ssr && !matchAlias(specifier)) {
              if (shouldExternalize(environment, specifier, importer)) {
                return
              }
              if (isBuiltin(environment.config.resolve.builtins, specifier)) {
                return
              }
            }
            // skip client
            if (specifier === clientPublicPath) {
              return
            }

            /**
             * /public 下的 JS/CSS 不经过插件 transform，不能像源码模块一样被 import。
             * 如果确实想拿资源 URL，应使用 ?url，让它按静态资源路径处理。
             */
            if (
              specifier[0] === '/' &&
              !(
                config.assetsInclude(cleanUrl(specifier)) ||
                urlRE.test(specifier)
              ) &&
              checkPublicFile(specifier, config)
            ) {
              throw new Error(
                `Cannot import non-asset file ${specifier} which is inside /public. ` +
                  `JS/CSS files inside /public are copied as-is on build and ` +
                  `can only be referenced via <script src> or <link href> in html. ` +
                  `If you want to get the URL of that file, use ${injectQuery(
                    specifier,
                    'url',
                  )} instead.`,
              )
            }

            /**
             * 解析并规范化 import URL。
             * 返回的 url 是浏览器实际请求的路径，resolvedId 是模块图和插件内部使用的 id。
             */
            let [url, resolvedId] = await normalizeUrl(specifier, start)
            resolvedId = resolvedId || url

            /**
             * 记录为安全模块路径，避免后续文件访问检查把已经由 import 链路确认过的模块误拦截。
             * 这里存储时要去掉 base 前缀，因为安全路径比较基于文件系统路径。
             */
            config.safeModulePaths.add(fsPathFromUrl(stripBase(url, base)))

            if (url !== specifier) {
              /**
               * normalizeUrl 后，如果浏览器最终请求的 url 和源码里的 specifier 不一样，
               * 就需要改写 import 语句。这里先处理两个“不能简单替换字符串”的特殊场景：
               * 1. 预构建 CJS 依赖的 named import 互操作；
               * 2. 浏览器环境下 Node builtin external stub 的 named import 报错兼容。
               * 其他普通依赖才走最后的默认 URL 替换。
               */
              let rewriteDone = false
              if (
                !depsOptimizer?.isOptimizedDepFile(importer) &&
                depsOptimizer?.isOptimizedDepFile(resolvedId) &&
                !optimizedDepChunkRE.test(resolvedId)
              ) {
                /**
                 * 场景一：源码写了 named import，但目标是预构建后的 CJS 依赖。
                 *
                 * CJS 本质上通常只有 default/module.exports，浏览器执行 ESM named import
                 * 可能拿不到预期字段。Vite 会根据 optimizer metadata 判断是否需要 interop；
                 * 如果需要，就把 named import 改写成基于 default 的访问，保证 dev 期行为接近 Node/bundler。
                 */
                const file = cleanUrl(resolvedId) // Remove ?v={hash}

                const depInfo = optimizedDepInfoFromFile(
                  depsOptimizer.metadata,
                  file,
                )
                const needsInterop = await optimizedDepNeedsInterop(
                  environment,
                  depsOptimizer.metadata,
                  file,
                )

                if (needsInterop === undefined) {
                  /**
                   * 非入口动态依赖可能没有 optimizer metadata，通常也不需要 interop。
                   * 如果它本应是动态入口却没有信息，说明预构建元数据异常，记录一条内部错误。
                   */
                  if (depInfo?.isDynamicEntry) {
                    config.logger.error(
                      colors.red(
                        `Vite Error, ${url} optimized info should be defined`,
                      ),
                    )
                  }
                } else if (needsInterop) {
                  debug?.(`${url} needs interop`)
                  interopNamedImports(
                    str(),
                    importSpecifier,
                    url,
                    index,
                    importer,
                    isNodeMode(),
                    config,
                  )
                  rewriteDone = true
                }
              }
              /**
               * 场景二：源码在浏览器环境导入 Node builtin，比如 import { readFile } from 'fs'。
               *
               * 这类模块会被替换成 browser external stub；stub 通常只有 default 导出。
               * 如果源码用了 named import，直接执行会得到不清晰的浏览器 ESM 报错；
               * 这里套一层 interop，让最终抛出 Vite 定制的“浏览器不支持该 builtin”提示。
               */
              else if (
                url.startsWith(wrapId(browserExternalId)) &&
                source.slice(expStart, start).includes('{')
              ) {
                interopNamedImports(
                  str(),
                  importSpecifier,
                  url,
                  index,
                  importer,
                  isNodeMode(),
                  config,
                )
                rewriteDone = true
              }
              if (!rewriteDone) {
                /**
                 * 场景三：普通 URL 替换。
                 *
                 * 大多数依赖都会走到这里：把源码中的原始 specifier
                 * 替换成 normalizeUrl 得到的浏览器可请求 URL。
                 * 静态 import 的 start/end 不包含引号，所以要向两侧扩一位；
                 * 动态 import 的 start/end 已经指向字符串内容，只覆盖内容即可。
                 */
                const rewrittenUrl = JSON.stringify(url)
                const s = isDynamicImport ? start : start - 1
                const e = isDynamicImport ? end : end + 1
                str().overwrite(s, e, rewrittenUrl, {
                  contentOnly: true,
                })
              }
            }

            /**
             * 记录本地依赖，后面交给 updateModuleInfo 建立 HMR 需要的 import 链。
             * 这里去掉 base 和内部 wrap，模块图里保存的是规范化后的模块 URL。
             */
            const hmrUrl = unwrapId(stripBase(url, base))
            const isLocalImport = !isExternalUrl(hmrUrl) && !isDataUrl(hmrUrl)
            if (isLocalImport) {
              orderedImportedUrls[index] = hmrUrl
            }

            if (enablePartialAccept && importedBindings) {
              /**
               * 部分接受导出时，需要记录“当前 importer 从这个依赖里实际用了哪些导出”。
               *
               * 例如当前模块写了 import { foo, bar } from './dep'，
               * extractImportedBindings 会记录 './dep' 对应的 binding 集合是 { foo, bar }。
               * 后面 HMR 传播到 './dep' 时，会拿这组 importedBindings 和 dep 自己声明的
               * acceptedHmrExports 对比：如果 foo/bar 都被 dep 接受，就可以停止向上冒泡；
               * 只要有一个导出没被接受，就还要继续找更上层的 HMR 边界。
               */
              extractImportedBindings(
                resolvedId,
                source,
                importSpecifier,
                importedBindings,
              )
            }

            if (
              !isDynamicImport &&
              isLocalImport &&
              environment.config.dev.preTransformRequests
            ) {
              /**
               * 对已知的静态本地依赖做预热转换。
               * 这不会替代浏览器真实请求，但能提前进入 transformRequest，
               * 也能让 deps optimizer 等待这批 crawl 请求结束。
               */
              const url = removeImportQuery(hmrUrl)
              environment.warmupRequest(url)
            }
          } else if (!importer.startsWith(withTrailingSlash(clientDir))) {
            if (!isInNodeModules(importer)) {
              /**
               * 复杂动态 import 无法静态分析，Vite 只能给出提示。
               * 用户如果确认要保留运行时动态表达式，可以用 @vite-ignore 显式跳过警告。
               */
              const hasViteIgnore = hasViteIgnoreRE.test(
                // complete expression inside parens
                source.slice(dynamicIndex + 1, end),
              )
              if (!hasViteIgnore) {
                this.warn(
                  `\n` +
                    colors.cyan(importerModule.file) +
                    `\n` +
                    colors.reset(generateCodeFrame(source, start, end)) +
                    colors.yellow(
                      `\nThe above dynamic import cannot be analyzed by Vite.\n` +
                        `See ${colors.blue(
                          `https://github.com/rollup/plugins/tree/master/packages/dynamic-import-vars#limitations`,
                        )} ` +
                        `for supported dynamic import formats. ` +
                        `If this is intended to be left as-is, you can use the ` +
                        `/* @vite-ignore */ comment inside the import() call to suppress this warning.\n`,
                    ),
                )
              }
            }

            if (!ssr) {
              if (
                !urlIsStringRE.test(rawUrl) ||
                isExplicitImportRequired(rawUrl.slice(1, -1))
              ) {
                /**
                 * 对无法静态分析、但可能导入非 JS/CSS 资源的动态 import，
                 * 注入运行时 helper 给最终 URL 补 ?import，确保浏览器请求能落到正确资源处理分支。
                 */
                needQueryInjectHelper = true
                str().overwrite(
                  start,
                  end,
                  `__vite__injectQuery(${rawUrl}, 'import')`,
                  { contentOnly: true },
                )
              }
            }
          }
        }),
      )

      const _orderedImportedUrls = orderedImportedUrls.filter(isDefined)
      const importedUrls = new Set(_orderedImportedUrls)
      /**
       * importedUrls 是这次扫描得到的“依赖清单”，后面会交给 updateModuleInfo 变成真正的模块图边。
       * staticImportedUrls 只保留源码里的静态顶层 import 和动态 import，
       * 用于 HMR 软失效时判断哪些 importer 只需要更新时间戳。
       */
      const staticImportedUrls = new Set(
        _orderedImportedUrls.map((url) => removeTimestampQuery(url)),
      )
      const acceptedUrls = mergeAcceptedUrls(orderedAcceptedUrls)
      const acceptedExports = mergeAcceptedUrls(orderedAcceptedExports)

      // While we always expect to work with ESM, a classic worker is the only
      // case where it's not ESM and we need to avoid injecting ESM-specific code
      const isClassicWorker =
        importer.includes(WORKER_FILE_ID) && importer.includes('type=classic')

      if (hasEnv && !isClassicWorker) {
        /**
         * 只要源码使用了 import.meta.env，就在模块头部注入当前环境的 env 对象。
         * classic worker 不能直接注入 ESM 语法，所以这里跳过。
         */
        str().prepend(getEnv(ssr))
      }

      if (hasHMR && !ssr && !isClassicWorker) {
        debugHmr?.(
          `${
            isSelfAccepting
              ? `[self-accepts]`
              : isPartiallySelfAccepting
                ? `[accepts-exports]`
                : acceptedUrls.size
                  ? `[accepts-deps]`
                  : `[detected api usage]`
          } ${prettifyUrl(importer, root)}`,
        )
        /**
         * inject hot context
         * 注入之后，业务代码里的 import.meta.hot 才能和浏览器端 HMRClient 建立联系。
         */
        str().prepend( // 🔖断点[小册06/08] 注入 import.meta.hot = createHotContext(...),HMR 接入点
          `import { createHotContext as __vite__createHotContext } from "${clientPublicPath}";` +
            `import.meta.hot = __vite__createHotContext(${JSON.stringify(
              normalizeHmrUrl(importerModule.url),
            )});`,
        )
      }

      if (needQueryInjectHelper) {
        /**
         * 只有遇到无法静态确定类型的动态 import 时，才按需注入 injectQuery helper。
         * classic worker 不能用 ESM import 注入 helper，所以直接把函数实现 append 到文件末尾。
         */
        if (isClassicWorker) {
          str().append('\n' + __vite__injectQuery.toString())
        } else {
          str().prepend(
            `import { injectQuery as __vite__injectQuery } from "${clientPublicPath}";`,
          )
        }
      }

      /**
       * 处理 import.meta.hot.accept(...) 中声明的 HMR 接受依赖。
       * 前面遇到 import.meta.hot.accept(...) 时，已经用 lexAcceptedHmrDeps
       * 把 accept 参数里的 URL 词法收集到了 acceptedUrls；
       * 但那一步只是收集 HMR 边界声明，没有把它当普通 import 加进 importedUrls，
       * 也没有 normalize 成模块图节点。
       *
       * 语义上，accept(dep, cb) 通常应该对应当前模块的直接依赖：
       * 普通 import 边负责让 HMR 从 dep 传播到当前模块，
       * acceptedHmrDeps 则负责告诉 propagateUpdate“传播到这里可以停下”。
       * 如果只写 accept 但没有对应 import 边，这里仍会记录接受关系，
       * 但文件变更时未必能沿 importers 走到当前模块。
       *
       * 因此 accept 里的 URL 也要单独 normalize，确保它和普通 import 指向同一个模块图节点。
       * 注意这里收集到的是 normalizedAcceptedUrls，不会把 accept URL 当成普通 import加进 importedUrls；
       * 后面 updateModuleInfo 会把它写成 acceptedHmrDeps，
       * 而不是 importedModules。
       */
      const normalizedAcceptedUrls = new Set<string>()
      for (const { url, start, end } of acceptedUrls) {
        let [normalized, resolvedId] = await normalizeUrl(url, start).catch(
          () => [],
        )
        if (resolvedId) {
          const mod = moduleGraph.getModuleById(resolvedId)
          if (!mod) {
            this.error(
              `module was not found for ${JSON.stringify(resolvedId)}`,
              start,
            )
            return
          }
          normalized = mod.url
        } else {
          this.error({
            message: `Failed to resolve ${JSON.stringify(url)} from ${importer}.`,
            pos: start,
          })
        }
        normalizedAcceptedUrls.add(normalized)
        const hmrAccept = normalizeHmrUrl(normalized)
        str().overwrite(start, end, JSON.stringify(hmrAccept), {
          contentOnly: true,
        })
      }

      /**
       * 更新 JS 模块图关系，供后续 HMR 分析使用。
       * 普通 CSS import 的依赖关系由 css-analysis 插件维护；
       * 但 .css?raw、.css?url 这类特殊查询仍按 JS import 处理。
       */
      if (!isCSSRequest(importer) || SPECIAL_QUERY_RE.test(importer)) {
        /**
         * 插件在 transform 阶段通过 this.addWatchFile() 添加的文件，也要并入模块图依赖。
         * 这些文件不一定出现在源码 import 语句里，但变更时仍应触发当前模块更新。
         */
        const pluginImports = (this as unknown as TransformPluginContext)
          ._addedImports
        if (pluginImports) {
          ;(
            await Promise.all(
              [...pluginImports].map((id) => normalizeUrl(id, 0, true)),
            )
          ).forEach(([url]) => importedUrls.add(stripBase(url, base)))
        }
        /**
         * SSR 环境不会注入浏览器端 HMR 运行时代码。
         * 如果模块之前已经标记为自接受，这里保持原状态，避免 SSR transform 把它误清掉。
         */
        if (ssr && importerModule.isSelfAccepting) {
          isSelfAccepting = true
        }
        /**
         * acceptExports 如果覆盖了模块的全部导出，效果等价于自接受模块。
         * 这样 HMR 向上传播时可以在当前模块停止，不需要继续找更上层 importer。
         */
        if (
          !isSelfAccepting &&
          isPartiallySelfAccepting &&
          acceptedExports.size >= exports.length &&
          exports.every((e) => acceptedExports.has(e.n))
        ) {
          isSelfAccepting = true
        }
        /**
         * import analysis 的最终产物不只是改写后的 code，还包括模块图关系。
         * 前面 normalizeUrl 只是确保依赖节点存在，并把依赖 URL 收集到 importedUrls；
         * 这里才根据 importedUrls 重建 importedModules/importers 双向边，
         * 同时写入 HMR accept 关系，供后续文件变更时向上寻找更新边界。
         */
        const prunedImports = await moduleGraph.updateModuleInfo( // 🔖断点[小册06/08/09] import-analysis 扫描结束后写入依赖边与 HMR accept 关系
          importerModule,
          importedUrls,
          importedBindings,
          normalizedAcceptedUrls,
          isPartiallySelfAccepting ? acceptedExports : null,
          isSelfAccepting,
          staticImportedUrls,
        )
        if (prunedImports) {
          handlePrunedModules(prunedImports, environment)
        }
      }

      debug?.(
        `${timeFrom(msAtStart)} ${colors.dim(
          `[${importedUrls.size} imports rewritten] ${prettifyUrl(
            importer,
            root,
          )}`,
        )}`,
      )

      if (s) {
        return transformStableResult(s, importer, config)
      } else {
        return source
      }
    },
  }
}

function mergeAcceptedUrls<T>(orderedUrls: Array<Set<T> | undefined>) {
  const acceptedUrls = new Set<T>()
  for (const urls of orderedUrls) {
    if (!urls) continue
    for (const url of urls) acceptedUrls.add(url)
  }
  return acceptedUrls
}

export function createParseErrorInfo(
  importer: string,
  source: string,
): { message: string; showCodeFrame: boolean } {
  const isVue = importer.endsWith('.vue')
  const isJsx = importer.endsWith('.jsx') || importer.endsWith('.tsx')
  const maybeJSX = !isVue && isJSRequest(importer)
  const probablyBinary = source.includes(
    '\ufffd' /* unicode replacement character */,
  )

  const msg = isVue
    ? `Install @vitejs/plugin-vue to handle .vue files.`
    : maybeJSX
      ? isJsx
        ? `If you use tsconfig.json, make sure to not set jsx to preserve.`
        : `If you are using JSX, make sure to name the file with the .jsx or .tsx extension.`
      : `You may need to install appropriate plugins to handle the ${path.extname(
          importer,
        )} file format, or if it's an asset, add "**/*${path.extname(
          importer,
        )}" to \`assetsInclude\` in your configuration.`

  return {
    message:
      `Failed to parse source for import analysis because the content ` +
      `contains invalid JS syntax. ` +
      msg,
    showCodeFrame: !probablyBinary,
  }
}

const interopHelper = (m: any, n: boolean) =>
  n || !m?.__esModule
    ? {
        ...((typeof m === 'object' && !Array.isArray(m)) ||
        typeof m === 'function'
          ? m
          : {}),
        default: m,
      }
    : m
const interopHelperStr = interopHelper.toString().replaceAll('\n', '')

export function interopNamedImports(
  str: MagicString,
  importSpecifier: ImportSpecifier,
  rewrittenUrl: string,
  importIndex: number,
  importer: string,
  isNodeMode: boolean,
  config: ResolvedConfig,
): void {
  const source = str.original
  const {
    s: start,
    e: end,
    ss: expStart,
    se: expEnd,
    d: dynamicIndex,
  } = importSpecifier
  const exp = source.slice(expStart, expEnd)
  if (dynamicIndex > -1) {
    const inconsistentCjsInterop = !!config.legacy?.inconsistentCjsInterop
    // rewrite `import('package')` to expose the default directly
    str.overwrite(
      expStart,
      expEnd,
      `import('${rewrittenUrl}').then(m => (${interopHelperStr})(m.default, ${inconsistentCjsInterop ? 0 : 1}))` +
        getLineBreaks(exp),
      { contentOnly: true },
    )
  } else {
    const rawUrl = source.slice(start, end)
    const rewritten = transformCjsImport(
      exp,
      rewrittenUrl,
      rawUrl,
      importIndex,
      importer,
      isNodeMode,
      config,
    )
    if (rewritten) {
      str.overwrite(
        expStart,
        expEnd,
        rewritten.importLine + getLineBreaks(exp),
        { contentOnly: true },
      )
      if (rewritten.hoistedAssignments) {
        str.appendLeft(
          getFileStartIndex(source),
          rewritten.hoistedAssignments + ';',
        )
      }
    } else {
      // #1439 export * from '...'
      str.overwrite(
        start,
        end,
        rewrittenUrl + getLineBreaks(source.slice(start, end)),
        {
          contentOnly: true,
        },
      )
    }
  }
}

// get line breaks to preserve line count for not breaking source maps
function getLineBreaks(str: string) {
  return str.includes('\n') ? '\n'.repeat(str.split('\n').length - 1) : ''
}

type ImportNameSpecifier = { importedName: string; localName: string }

/**
 * Detect import statements to a known optimized CJS dependency and provide
 * ES named imports interop. We do this by rewriting named imports to a variable
 * assignment to the corresponding property on the `module.exports` of the cjs
 * module. Note this doesn't support dynamic re-assignments from within the cjs
 * module.
 *
 * Note that es-module-lexer treats `export * from '...'` as an import as well,
 * so, we may encounter ExportAllDeclaration here, in which case `undefined`
 * will be returned.
 *
 * Credits \@csr632 via #837
 */
export function transformCjsImport(
  importExp: string,
  url: string,
  rawUrl: string,
  importIndex: number,
  importer: string,
  isNodeMode: boolean,
  config: ResolvedConfig,
): { importLine: string; hoistedAssignments?: string } | undefined {
  const node = parseAst(importExp).body[0]

  // `export * from '...'` may cause unexpected problem, so give it a warning
  if (
    config.command === 'serve' &&
    node.type === 'ExportAllDeclaration' &&
    !node.exported
  ) {
    config.logger.warn(
      colors.yellow(
        `\nUnable to interop \`${importExp}\` in ${importer}, this may lose module exports. Please export "${rawUrl}" as ESM or use named exports instead, e.g. \`export { A, B } from "${rawUrl}"\``,
      ),
    )
  } else if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration'
  ) {
    if (!node.specifiers.length) {
      return { importLine: `import "${url}"` }
    }

    const importNames: ImportNameSpecifier[] = []
    const exportNames: string[] = []
    let defaultExports: string = ''
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier') {
        const importedName = getIdentifierNameOrLiteralValue(spec.imported)
        const localName = spec.local.name
        importNames.push({ importedName, localName })
      } else if (spec.type === 'ImportDefaultSpecifier') {
        importNames.push({
          importedName: 'default',
          localName: spec.local.name,
        })
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        importNames.push({ importedName: '*', localName: spec.local.name })
      } else if (spec.type === 'ExportSpecifier') {
        // for ExportSpecifier, local name is same as imported name
        // prefix the variable name to avoid clashing with other local variables
        const importedName = getIdentifierNameOrLiteralValue(spec.local)
        // we want to specify exported name as variable and re-export it
        const exportedName = getIdentifierNameOrLiteralValue(spec.exported)
        if (exportedName === 'default') {
          defaultExports = makeLegalIdentifier(
            `__vite__cjsExportDefault_${importIndex}`,
          )
          importNames.push({ importedName, localName: defaultExports })
        } else {
          const localName = `__vite__cjsExport${
            spec.exported.type === 'Literal'
              ? `L_${getHash(spec.exported.value)}`
              : 'I_' + spec.exported.name
          }`
          importNames.push({ importedName, localName })
          exportNames.push(
            `${localName} as ${spec.exported.type === 'Literal' ? JSON.stringify(exportedName) : exportedName}`,
          )
        }
      }
    }

    // If there is multiple import for same id in one file,
    // importIndex will prevent the cjsModuleName to be duplicate
    const cjsModuleName = makeLegalIdentifier(
      `__vite__cjsImport${importIndex}_${rawUrl}`,
    )
    const importLine = `import ${cjsModuleName} from "${url}"`
    const lines: string[] = []
    importNames.forEach(({ importedName, localName }) => {
      if (importedName === '*') {
        lines.push(
          `const ${localName} = (${interopHelperStr})(${cjsModuleName}, ${+isNodeMode})`,
        )
      } else if (importedName === 'default') {
        if (isNodeMode) {
          lines.push(`const ${localName} = ${cjsModuleName}`)
        } else {
          lines.push(
            `const ${localName} = !${cjsModuleName}.__esModule ? ${cjsModuleName} : ${cjsModuleName}.default`,
          )
        }
      } else {
        lines.push(`const ${localName} = ${cjsModuleName}["${importedName}"]`)
      }
    })
    if (defaultExports) {
      lines.push(`export default ${defaultExports}`)
    }
    if (exportNames.length) {
      lines.push(`export { ${exportNames.join(', ')} }`)
    }

    return { importLine, hoistedAssignments: lines.join('; ') }
  }
}

function getIdentifierNameOrLiteralValue(node: ESTree.ModuleExportName) {
  return node.type === 'Identifier' ? node.name : node.value
}

// Copied from `client/client.ts`. Only needed so we can inline inject this function for classic workers.
function __vite__injectQuery(url: string, queryToInject: string): string {
  // skip urls that won't be handled by vite
  if (url[0] !== '.' && url[0] !== '/') {
    return url
  }

  // can't use pathname from URL since it may be relative like ../
  const pathname = url.replace(/[?#].*$/, '')
  const { search, hash } = new URL(url, 'http://vite.dev')

  return `${pathname}?${queryToInject}${search ? `&` + search.slice(1) : ''}${
    hash || ''
  }`
}
