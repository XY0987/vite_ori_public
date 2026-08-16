import path from 'node:path'
import fs from 'node:fs'
import type { Connect } from '#dep-types/connect'
import { createDebugger, joinUrlSegments } from '../../utils'
import { cleanUrl } from '../../../shared/utils'
import type { DevEnvironment } from '../environment'

const debug = createDebugger('vite:html-fallback')

export function htmlFallbackMiddleware(
  root: string,
  spaFallback: boolean,
  clientEnvironment?: DevEnvironment,
): Connect.NextHandleFunction {
  // dev bundledDev 会优先从内存 bundle 判断文件是否存在；preview 没有 clientEnvironment，
  // 因此只会到 root(distDir) 下查磁盘文件。
  const memoryFiles = clientEnvironment?.bundledDev?.memoryFiles

  function checkFileExists(relativePath: string) {
    return (
      memoryFiles?.has(
        relativePath.slice(1), // remove first /
      ) ?? fs.existsSync(path.join(root, relativePath))
    )
  }

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteHtmlFallbackMiddleware(req, _res, next) {
    // 这个 middleware 只处理“浏览器请求 HTML 页面”的场景。
    // 非 GET/HEAD、favicon、或不接受 HTML 的资源请求，都直接交给后续中间件。
    if (
      // Only accept GET or HEAD
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      // Exclude default favicon requests
      req.url === '/favicon.ico' ||
      // Require Accept: text/html or */*
      !(
        req.headers.accept === undefined || // equivalent to `Accept: */*`
        req.headers.accept === '' || // equivalent to `Accept: */*`
        req.headers.accept.includes('text/html') ||
        req.headers.accept.includes('*/*')
      )
    ) {
      return next()
    }

    const url = cleanUrl(req.url!)
    let pathname
    try {
      // URL 可能带编码字符，回退判断前先转成真实 pathname。
      pathname = decodeURIComponent(url)
    } catch {
      // ignore malformed URI
      return next()
    }

    // .html files are not handled by serveStaticMiddleware
    // so we need to check if the file exists
    if (pathname.endsWith('.html')) {
      // /foo.html 存在时只清理 query/hash 后继续给后面的 HTML middleware 读取。
      if (checkFileExists(pathname)) {
        debug?.(`Rewriting ${req.method} ${req.url} to ${url}`)
        req.url = url
        return next()
      }
    }
    // trailing slash should check for fallback index.html
    else if (pathname.endsWith('/')) {
      // /foo/ 优先回退到 /foo/index.html，兼容多页目录式输出。
      if (checkFileExists(joinUrlSegments(pathname, 'index.html'))) {
        const newUrl = url + 'index.html'
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`)
        req.url = newUrl
        return next()
      }
    }
    // non-trailing slash should check for fallback .html
    else {
      // /foo 优先尝试 /foo.html，兼容 MPA 里无后缀访问 HTML 文件。
      if (checkFileExists(pathname + '.html')) {
        const newUrl = url + '.html'
        debug?.(`Rewriting ${req.method} ${req.url} to ${newUrl}`)
        req.url = newUrl
        return next()
      }
    }

    if (spaFallback) {
      // SPA 模式最后兜底到 /index.html；这里仍然只是改写 req.url，不直接发送文件。
      debug?.(`Rewriting ${req.method} ${req.url} to /index.html`)
      req.url = '/index.html'
    }

    next()
  }
}
