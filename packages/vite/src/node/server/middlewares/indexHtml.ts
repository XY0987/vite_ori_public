import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import MagicString from 'magic-string'
import type { SourceMapInput } from 'rolldown'
import type { DefaultTreeAdapterMap, Token } from 'parse5'
import type { Connect } from '#dep-types/connect'
import type { IndexHtmlTransformHook } from '../../plugins/html'
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  extractImportExpressionFromClassicScript,
  findNeedTransformStyleAttribute,
  getScriptInfo,
  htmlEnvHook,
  htmlProxyResult,
  injectCspNonceMetaTagHook,
  injectNonceAttributeTagHook,
  nodeIsElement,
  overwriteAttrValue,
  postImportMapHook,
  preImportMapHook,
  removeViteIgnoreAttr,
  resolveHtmlTransforms,
  traverseHtml,
} from '../../plugins/html'
import type { PreviewServer, ResolvedConfig, ViteDevServer } from '../..'
import { send } from '../send'
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from '../../constants'
import {
  ensureWatchedFile,
  fsPathFromId,
  getHash,
  injectQuery,
  isCSSRequest,
  isDevServer,
  isJSRequest,
  isParentDirectory,
  joinUrlSegments,
  normalizePath,
  processSrcSetSync,
  stripBase,
} from '../../utils'
import { checkPublicFile } from '../../publicDir'
import { getCodeWithSourcemap, injectSourcesContent } from '../sourcemap'
import { cleanUrl, unwrapId, wrapId } from '../../../shared/utils'
import { getNodeAssetAttributes } from '../../assetSource'
import {
  BasicMinimalPluginContext,
  basePluginContextMeta,
} from '../pluginContainer'
import { getHmrImplementation } from '../../plugins/clientInjections'
import { checkLoadingAccess, respondWithAccessDenied } from './static'

interface AssetNode {
  start: number
  end: number
  code: string
}

interface InlineStyleAttribute {
  index: number
  location: Token.Location
  code: string
}

export function createDevHtmlTransformFn(
  config: ResolvedConfig,
): (
  server: ViteDevServer,
  url: string,
  html: string,
  originalUrl?: string,
) => Promise<string> {
  const [preHooks, normalHooks, postHooks] = resolveHtmlTransforms(
    config.plugins,
  )
  /**
   * 核心逻辑：HTML transform 有自己独立的钩子顺序。
   * Vite 内置的 importmap/env/html-proxy/client 注入穿插在用户 pre/normal/post 钩子之间，不走普通模块 transform 顺序。
   */
  const transformHooks = [
    preImportMapHook(config),
    injectCspNonceMetaTagHook(config),
    ...preHooks,
    htmlEnvHook(config),
    devHtmlHook,
    ...normalHooks,
    ...postHooks,
    injectNonceAttributeTagHook(config),
    postImportMapHook(config),
  ]
  const pluginContext = new BasicMinimalPluginContext(
    { ...basePluginContextMeta, watchMode: true },
    config.logger,
  )
  return (
    server: ViteDevServer,
    url: string,
    html: string,
    originalUrl?: string,
  ): Promise<string> => {
    return applyHtmlTransforms(html, transformHooks, pluginContext, {
      path: url,
      filename: getHtmlFilename(url, server),
      server,
      originalUrl,
    })
  }
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url))
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1))),
    )
  }
}

function shouldPreTransform(url: string, config: ResolvedConfig) {
  return (
    !checkPublicFile(url, config) && (isJSRequest(url) || isCSSRequest(url))
  )
}

const wordCharRE = /\w/

function isBareRelative(url: string) {
  return wordCharRE.test(url[0]) && !url.includes(':')
}

function getHtmlDirnameForRelativeUrl(htmlPath: string): string {
  return htmlPath.endsWith('/') ? htmlPath : path.posix.dirname(htmlPath)
}

const processNodeUrl = (
  url: string,
  useSrcSetReplacer: boolean,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  server?: ViteDevServer,
  isClassicScriptLink?: boolean,
): string => {
  // prefix with base (dev only, base is never relative)
  const replacer = (url: string) => {
    if (
      (url[0] === '/' && url[1] !== '/') ||
      // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
      // path will add `/a/` prefix, it will caused 404.
      //
      // skip if url contains `:` as it implies a url protocol or Windows path that we don't want to replace.
      //
      // rewrite `./index.js` -> `localhost:5173/a/index.js`.
      // rewrite `../index.js` -> `localhost:5173/index.js`.
      // rewrite `relative/index.js` -> `localhost:5173/a/relative/index.js`.
      ((url[0] === '.' || isBareRelative(url)) &&
        originalUrl &&
        originalUrl !== '/' &&
        htmlPath === '/index.html')
    ) {
      url = path.posix.join(config.base, url)
    }

    let preTransformUrl: string | undefined

    if (!isClassicScriptLink && shouldPreTransform(url, config)) {
      if (url[0] === '/' && url[1] !== '/') {
        preTransformUrl = url
      } else if (url[0] === '.' || isBareRelative(url)) {
        preTransformUrl = path.posix.join(
          config.base,
          getHtmlDirnameForRelativeUrl(htmlPath),
          url,
        )
      }
    }

    if (server) {
      const mod = server.environments.client.moduleGraph.urlToModuleMap.get(
        preTransformUrl || url,
      )
      if (mod && mod.lastHMRTimestamp > 0) {
        url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
      }
    }

    if (server && preTransformUrl) {
      try {
        preTransformUrl = decodeURI(preTransformUrl)
      } catch {
        // Malformed uri. Skip pre-transform.
        return url
      }
      preTransformRequest(server, preTransformUrl, config.decodedBase)
    }

    return url
  }

  const processedUrl = useSrcSetReplacer
    ? processSrcSetSync(url, ({ url }) => replacer(url))
    : replacer(url)
  return processedUrl
}
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl },
) => {
  const { config, watcher } = server!
  const base = config.base || '/'
  const decodedBase = config.decodedBase || '/'

  let proxyModulePath: string
  let proxyModuleUrl: string

  const trailingSlash = htmlPath.endsWith('/')
  if (!trailingSlash && fs.existsSync(filename)) {
    // If htmlPath is a /@fs/ URL (e.g. vitest-browser always uses this form
    // for testerHtmlPath), normalise to an absolute FS path so proxyCacheUrl
    // is always root-relative.
    proxyModulePath = htmlPath.startsWith(FS_PREFIX) ? filename : htmlPath
    proxyModuleUrl = htmlPath
  } else {
    // There are users of vite.transformIndexHtml calling it with url '/'
    // for SSR integrations #7993, filename is root for this case
    // A user may also use a valid name for a virtual html file
    // Mark the path as virtual in both cases so sourcemaps aren't processed
    // and ids are properly handled
    const validPath = `${htmlPath}${trailingSlash ? 'index.html' : ''}`
    proxyModulePath = `\0${validPath}`
    proxyModuleUrl = wrapId(proxyModulePath)
  }
  proxyModuleUrl = joinUrlSegments(decodedBase, proxyModuleUrl)

  const s = new MagicString(html)
  let inlineModuleIndex = -1
  // The key to the proxyHtml cache is decoded, as it will be compared
  // against decoded URLs by the HTML plugins.
  const proxyCacheUrl = decodeURI(
    cleanUrl(proxyModulePath).replace(normalizePath(config.root), ''),
  )
  const styleUrl: AssetNode[] = []
  const inlineStyles: InlineStyleAttribute[] = []
  const inlineModulePaths: string[] = []

  const addInlineModule = (
    node: DefaultTreeAdapterMap['element'],
    ext: 'js',
  ) => {
    /**
     * 核心逻辑：HTML 里的内联 <script type="module"> 不直接留在 HTML 中处理。
     * dev 期会把它抽成 ?html-proxy 虚拟模块，让它进入普通的 resolve/load/transform 链路。
     */
    inlineModuleIndex++

    const contentNode = node.childNodes[0] as DefaultTreeAdapterMap['textNode']

    const code = contentNode.value

    let map: SourceMapInput | undefined
    if (proxyModulePath[0] !== '\0') {
      map = new MagicString(html)
        .snip(
          contentNode.sourceCodeLocation!.startOffset,
          contentNode.sourceCodeLocation!.endOffset,
        )
        .generateMap({ hires: 'boundary' })
      map.sources = [filename]
      map.file = filename
    }

    // add HTML Proxy to Map
    addToHTMLProxyCache(config, proxyCacheUrl, inlineModuleIndex, { code, map })

    // inline js module. convert to src="proxy" (dev only, base is never relative)
    const modulePath = `${proxyModuleUrl}?html-proxy&index=${inlineModuleIndex}.${ext}`
    inlineModulePaths.push(modulePath)

    s.update(
      node.sourceCodeLocation!.startOffset,
      node.sourceCodeLocation!.endOffset,
      `<script type="module" src="${modulePath}"></script>`,
    )
    preTransformRequest(server!, modulePath, decodedBase)
  }

  await traverseHtml(html, filename, config.logger.warn, (node) => {
    if (!nodeIsElement(node)) {
      return
    }

    // script tags
    if (node.nodeName === 'script') {
      const { src, srcSourceCodeLocation, isModule, isIgnored } =
        getScriptInfo(node)

      if (isIgnored) {
        removeViteIgnoreAttr(s, node.sourceCodeLocation!)
      } else if (src) {
        const processedUrl = processNodeUrl(
          src.value,
          /* useSrcSetReplacer */ false,
          config,
          htmlPath,
          originalUrl,
          server,
          !isModule,
        )
        if (processedUrl !== src.value) {
          overwriteAttrValue(s, srcSourceCodeLocation!, processedUrl)
        }
      } else if (isModule && node.childNodes.length) {
        addInlineModule(node, 'js')
      } else if (node.childNodes.length) {
        const scriptNode = node.childNodes[
          node.childNodes.length - 1
        ] as DefaultTreeAdapterMap['textNode']
        for (const {
          url,
          start,
          end,
        } of extractImportExpressionFromClassicScript(scriptNode)) {
          const processedUrl = processNodeUrl(
            url,
            false,
            config,
            htmlPath,
            originalUrl,
          )
          if (processedUrl !== url) {
            s.update(start, end, processedUrl)
          }
        }
      }
    }

    const inlineStyle = findNeedTransformStyleAttribute(node)
    if (inlineStyle) {
      inlineModuleIndex++
      inlineStyles.push({
        index: inlineModuleIndex,
        location: inlineStyle.location!,
        code: inlineStyle.attr.value,
      })
    }

    if (node.nodeName === 'style' && node.childNodes.length) {
      const children = node.childNodes[0] as DefaultTreeAdapterMap['textNode']
      styleUrl.push({
        start: children.sourceCodeLocation!.startOffset,
        end: children.sourceCodeLocation!.endOffset,
        code: children.value,
      })
    }

    // elements with [href/src] attrs
    const assetAttributes = getNodeAssetAttributes(
      node,
      config.html?.additionalAssetSources,
    )
    for (const attr of assetAttributes) {
      if (attr.type === 'remove') {
        s.remove(attr.location.startOffset, attr.location.endOffset)
      } else {
        const processedUrl = processNodeUrl(
          attr.value,
          attr.type === 'srcset',
          config,
          htmlPath,
          originalUrl,
        )
        if (processedUrl !== attr.value) {
          overwriteAttrValue(s, attr.location, processedUrl)
        }
      }
    }
  })

  // invalidate the module so the newly cached contents will be served
  const clientModuleGraph = server?.environments.client.moduleGraph
  if (clientModuleGraph) {
    await Promise.all(
      inlineModulePaths.map(async (url) => {
        const module = await clientModuleGraph.getModuleByUrl(url)
        if (module) {
          clientModuleGraph.invalidateModule(module)
        }
      }),
    )
  }

  await Promise.all([
    ...styleUrl.map(async ({ start, end, code }, index) => {
      const url = `${proxyModulePath}?html-proxy&direct&index=${index}.css`

      // ensure module in graph after successful load
      const mod =
        await server!.environments.client.moduleGraph.ensureEntryFromUrl(
          url,
          false,
        )
      ensureWatchedFile(watcher, mod.file, config.root)

      const result =
        await server!.environments.client.pluginContainer.transform(
          code,
          mod.id!,
        )
      let content = ''
      if (result.map && 'version' in result.map) {
        if (result.map.mappings) {
          await injectSourcesContent(result.map, proxyModulePath, config.logger)
        }
        content = getCodeWithSourcemap('css', result.code, result.map)
      } else {
        content = result.code
      }
      s.overwrite(start, end, content)
    }),
    ...inlineStyles.map(async ({ index, location, code }) => {
      // will transform with css plugin and cache result with css-post plugin
      const url = `${proxyModulePath}?html-proxy&inline-css&style-attr&index=${index}.css`

      const mod =
        await server!.environments.client.moduleGraph.ensureEntryFromUrl(
          url,
          false,
        )
      ensureWatchedFile(watcher, mod.file, config.root)

      await server?.environments.client.pluginContainer.transform(code, mod.id!)

      const hash = getHash(cleanUrl(mod.id!))
      const result = htmlProxyResult.get(`${hash}_${index}`)
      overwriteAttrValue(s, location, result ?? '')
    }),
  ])

  html = s.toString()

  /**
   * 核心逻辑：dev 期 HTML 会自动注入 /@vite/client。
   * 这和内联 module script 抽成 html-proxy 是两条路径：前者接入 HMR 客户端，后者让内联代码进入模块转换链。
   */
  return {
    html,
    tags: [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: path.posix.join(base, CLIENT_PUBLIC_PATH),
        },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export function indexHtmlMiddleware(
  root: string,
  server: ViteDevServer | PreviewServer,
): Connect.NextHandleFunction {
  // 关键分叉：dev server 有 pluginContainer，preview server 没有。
  // 后续是否检查 server.fs、是否 transformIndexHtml，都由这个布尔值决定。
  const isDev = isDevServer(server)
  // 只存在于 dev 的 bundledDev 模式；preview 永远不会进入这个内存 bundle 分支。
  const fullBundle = isDev && server.environments.client.bundledDev

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next()
    }

    const url = req.url && cleanUrl(req.url)
    // htmlFallbackMiddleware 会把可回退的页面请求补成 .html；script 请求不能按 HTML 处理。
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') {
      if (fullBundle) {
        // dev bundledDev 的 HTML 可能直接来自内存产物，避免每次都读磁盘文件。
        const pathname = decodeURIComponent(url)
        const filePath = pathname.slice(1) // remove first /

        let file = fullBundle.memoryFiles.get(filePath)
        if (!file && fullBundle.memoryFiles.size !== 0) {
          return next()
        }
        const secFetchDest = req.headers['sec-fetch-dest']
        if (
          [
            'document',
            'iframe',
            'frame',
            'fencedframe',
            '',
            undefined,
          ].includes(secFetchDest) &&
          ((await fullBundle.triggerBundleRegenerationIfStale()) ||
            file === undefined)
        ) {
          file = { source: await generateFallbackHtml(server as ViteDevServer) }
        }
        if (!file) {
          return next()
        }

        const html =
          typeof file.source === 'string'
            ? file.source
            : Buffer.from(file.source)
        const headers = server.config.server.headers
        return send(req, res, html, 'html', { headers, etag: file.etag })
      }

      let filePath: string
      if (isDev && url.startsWith(FS_PREFIX)) {
        // dev 支持 /@fs/ 访问允许范围内的真实文件路径。
        filePath = decodeURIComponent(fsPathFromId(url))
      } else {
        // preview 传入的 root 是 distDir；这里解析出来的就是构建产物里的 HTML 路径。
        filePath = normalizePath(
          path.resolve(path.join(root, decodeURIComponent(url))),
        )
      }

      if (isDev) {
        // dev 需要走 server.fs 访问控制，防止任意文件被作为 HTML 服务出去。
        const servingAccessResult = checkLoadingAccess(server.config, filePath)
        if (servingAccessResult === 'denied') {
          return respondWithAccessDenied(filePath, server, res)
        }
        if (servingAccessResult === 'fallback') {
          return next()
        }
        servingAccessResult satisfies 'allowed'
      } else {
        /**
         * 兼容逻辑：preview 不使用 dev server 的 server.fs 规则。
         * 它只允许访问 dist/root 内的文件，避免 preview 把构建产物目录外的文件暴露出去。
         */
        // `server.fs` options does not apply to the preview server.
        // But we should disallow serving files outside the output directory.
        if (!isParentDirectory(root, filePath)) {
          return next()
        }
      }

      if (fs.existsSync(filePath)) {
        // dev 和 preview 复用发送逻辑，但响应头来自各自的 server/preview 配置。
        const headers = isDev
          ? server.config.server.headers
          : server.config.preview.headers

        try {
          let html = await fsp.readFile(filePath, 'utf-8')
          /**
           * 核心逻辑：只有 dev server 会对 HTML 做 transformIndexHtml。
           * preview 只静态服务 build 产物，所以这里直接发送磁盘 HTML，边界非常明确。
           */
          if (isDev) { // 🔖断点[小册12] 仅 dev 走 transformIndexHtml;preview 在此被跳过(直出磁盘 HTML)
            html = await server.transformIndexHtml(url, html, req.originalUrl)
          }
          return send(req, res, html, 'html', { headers })
        } catch (e) {
          return next(e)
        }
      }
    }
    next()
  }
}

// NOTE: We usually don't prefix `url` and `base` with `decoded`, but in this file particularly
// we're dealing with mixed encoded/decoded paths often, so we make this explicit for now.
function preTransformRequest(
  server: ViteDevServer,
  decodedUrl: string,
  decodedBase: string,
) {
  if (!server.config.server.preTransformRequests) return

  // transform all url as non-ssr as html includes client-side assets only
  decodedUrl = unwrapId(stripBase(decodedUrl, decodedBase))
  server.warmupRequest(decodedUrl)
}

async function generateFallbackHtml(server: ViteDevServer) {
  const hmrRuntime = await getHmrImplementation(server.config)
  return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <script type="module">
    ${hmrRuntime.replaceAll('</script>', '<\\/script>')}
  </script>
  <style>
    :root {
      --page-bg: #ffffff;
      --text-color: #1d1d1f;
      --spinner-track: #f5f5f7;
      --spinner-accent: #0071e3;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --page-bg: #1e1e1e;
        --text-color: #f5f5f5;
        --spinner-track: #424242;
      }
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      background-color: var(--page-bg);
      color: var(--text-color);
    }

    .container {
      margin: auto;
      padding: 2rem;
      text-align: center;
      border-radius: 1rem;
    }

    .spinner {
      width: 3rem;
      height: 3rem;
      margin: 2rem auto;
      border: 3px solid var(--spinner-track);
      border-top-color: var(--spinner-accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg) } }
  </style>
</head>
<body>
  <div class="container">
    <h1>Bundling in progress</h1>
    <p>The page will automatically reload when ready.</p>
    <div class="spinner"></div>
  </div>
</body>
</html>
`
}
