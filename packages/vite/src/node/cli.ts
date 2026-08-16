import path from 'node:path'
import fs from 'node:fs'
import { inspect } from 'node:util'
import { performance } from 'node:perf_hooks'
import { cac } from 'cac'
import colors from 'picocolors'
import { VERSION } from './constants'
import type { BuildEnvironmentOptions } from './build'
import type { ServerOptions } from './server'
import type { CLIShortcut } from './shortcuts'
import type { LogLevel } from './logger'
import { createLogger } from './logger'
import type { InlineConfig } from './config'

function checkNodeVersion(nodeVersion: string): boolean {
  const currentVersion = nodeVersion.split('.')
  const major = parseInt(currentVersion[0], 10)
  const minor = parseInt(currentVersion[1], 10)
  const isSupported =
    (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22
  return isSupported
}

if (!checkNodeVersion(process.versions.node)) {
  // eslint-disable-next-line no-console
  console.warn(
    colors.yellow(
      `You are using Node.js ${process.versions.node}. ` +
        `Vite requires Node.js version 20.19+ or 22.12+. ` +
        `Please upgrade your Node.js version.`,
    ),
  )
}

const cli = cac('vite')

// global options
interface GlobalCLIOptions {
  '--'?: string[]
  c?: boolean | string
  config?: string
  base?: string
  l?: LogLevel
  logLevel?: LogLevel
  clearScreen?: boolean
  configLoader?: 'bundle' | 'runner' | 'native'
  d?: boolean | string
  debug?: boolean | string
  f?: string
  filter?: string
  m?: string
  mode?: string
  force?: boolean
  w?: boolean
}

interface ExperimentalDevOptions {
  experimentalBundle?: boolean
}

interface BuilderCLIOptions {
  app?: boolean
}

let profileSession = global.__vite_profile_session
let profileCount = 0

export const stopProfiler = (
  log: (message: string) => void,
): void | Promise<void> => {
  if (!profileSession) return
  return new Promise((res, rej) => {
    profileSession!.post('Profiler.stop', (err, { profile }) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const outPath = path.resolve(
          `./vite-profile-${profileCount++}.cpuprofile`,
        )
        fs.writeFileSync(outPath, JSON.stringify(profile))
        log(
          colors.yellow(
            `CPU profile written to ${colors.white(colors.dim(outPath))}`,
          ),
        )
        profileSession = undefined
        res()
      } else {
        rej(err)
      }
    })
  })
}

const filterDuplicateOptions = <T extends object>(options: T) => {
  for (const [key, value] of Object.entries(options)) {
    if (Array.isArray(value)) {
      options[key as keyof T] = value[value.length - 1]
    }
  }
}
/**
 * CLI 入口会把所有命令行参数先放进同一个 options 对象。
 * 这里把 --config、--mode、--debug 等全局参数剥离掉，
 * 只把真正属于 server/build/preview 子配置的字段继续往下传，
 * 避免这些全局字段混进 Rollup/Rolldown 或 server 选项。
 */
function cleanGlobalCLIOptions<Options extends GlobalCLIOptions>(
  options: Options,
): Omit<Options, keyof GlobalCLIOptions> {
  const ret = { ...options }
  delete ret['--']
  delete ret.c
  delete ret.config
  delete ret.base
  delete ret.l
  delete ret.logLevel
  delete ret.clearScreen
  delete ret.configLoader
  delete ret.d
  delete ret.debug
  delete ret.f
  delete ret.filter
  delete ret.m
  delete ret.mode
  delete ret.force
  delete ret.w

  /**
   * CLI 解析出的布尔值可能是字符串，
   * 这里提前转成内部配置真正需要的类型。
   */
  if ('sourcemap' in ret) {
    const sourcemap = ret.sourcemap as `${boolean}` | 'inline' | 'hidden'
    ret.sourcemap =
      sourcemap === 'true'
        ? true
        : sourcemap === 'false'
          ? false
          : ret.sourcemap
  }
  if ('watch' in ret) {
    const watch = ret.watch
    ret.watch = watch ? {} : undefined
  }

  return ret
}

/**
 * removing builder flags before passing as command specific sub-configs
 */
function cleanBuilderCLIOptions<Options extends BuilderCLIOptions>(
  options: Options,
): Omit<Options, keyof BuilderCLIOptions> {
  const ret = { ...options }
  delete ret.app
  return ret
}

/**
 * host may be a number (like 0), should convert to string
 */
const convertHost = (v: any) => {
  if (typeof v === 'number') {
    return String(v)
  }
  return v
}

/**
 * base may be a number (like 0), should convert to empty string
 */
const convertBase = (v: any) => {
  if (v === 0) {
    return ''
  }
  return v
}

cli
  .option('-c, --config <file>', `[string] use specified config file`)
  .option('--base <path>', `[string] public base path (default: /)`, {
    type: [convertBase],
  })
  .option('-l, --logLevel <level>', `[string] info | warn | error | silent`)
  .option('--clearScreen', `[boolean] allow/disable clear screen when logging`)
  .option(
    '--configLoader <loader>',
    `[string] use 'bundle' to bundle the config with Rolldown, or 'runner' (experimental) to process it on the fly, or 'native' (experimental) to load using the native runtime (default: bundle)`,
  )
  .option('-d, --debug [feat]', `[string | boolean] show debug logs`)
  .option('-f, --filter <filter>', `[string] filter debug logs`)
  .option('-m, --mode <mode>', `[string] set env mode`)

// dev
cli
  .command('[root]', 'start dev server') // default command
  .alias('serve') // the command is called 'serve' in Vite's API
  .alias('dev') // alias to align with the script name
  .option('--host [host]', `[string] specify hostname`, { type: [convertHost] })
  .option('--port <port>', `[number] specify port`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--cors', `[boolean] enable CORS`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option(
    '--force',
    `[boolean] force the optimizer to ignore the cache and re-bundle`,
  )
  .option(
    '--experimentalBundle',
    `[boolean] use experimental full bundle mode (this is highly experimental)`,
  )
  .action(
    async (
      root: string,
      options: ServerOptions & ExperimentalDevOptions & GlobalCLIOptions,
    ) => {
      filterDuplicateOptions(options)
      /**
       * CLI 文件本身保持轻量：只有真正进入 dev 命令时才加载 server 模块。
       * 这样 `vite --help`、`vite build` 等路径不会提前执行 dev server 相关初始化。
       */
      const { createServer } = await import('./server')
      try {
        /**
         * 启动主线第 1 段：createServer 负责解析配置、创建服务器基础设施和各环境，
         * 但返回 server 对象时底层 HTTP Server 还没有开始监听端口。
         */
        const server = await createServer({
          root,
          base: options.base,
          mode: options.mode,
          configFile: options.config,
          configLoader: options.configLoader,
          logLevel: options.logLevel,
          clearScreen: options.clearScreen,
          server: cleanGlobalCLIOptions(options),
          forceOptimizeDeps: options.force,
          experimental: {
            bundledDev: options.experimentalBundle,
          },
        })

        if (!server.httpServer) {
          throw new Error('HTTP server not available')
        }

        /**
         * 启动主线第 2 段：listen 会先触发 initServer -> environment.listen，
         * 在真正监听端口前初始化 HMR 和 depsOptimizer 等环境能力。
         */
        await server.listen()

        const info = server.config.logger.info

        const modeString =
          options.mode && options.mode !== 'development'
            ? `  ${colors.bgGreen(` ${colors.bold(options.mode)} `)}`
            : ''
        const viteStartTime = global.__vite_start_time ?? false
        const startupDurationString = viteStartTime
          ? colors.dim(
              `ready in ${colors.reset(
                colors.bold(Math.ceil(performance.now() - viteStartTime)),
              )} ms`,
            )
          : ''
        const hasExistingLogs =
          process.stdout.bytesWritten > 0 || process.stderr.bytesWritten > 0

        info(
          `\n  ${colors.green(
            `${colors.bold('VITE')} v${VERSION}`,
          )}${modeString}  ${startupDurationString}\n`,
          {
            clear: !hasExistingLogs,
          },
        )

        server.printUrls()
        const customShortcuts: CLIShortcut<typeof server>[] = []
        if (profileSession) {
          customShortcuts.push({
            key: 'p',
            description: 'start/stop the profiler',
            async action(server) {
              if (profileSession) {
                await stopProfiler(server.config.logger.info)
              } else {
                const inspector = await import('node:inspector').then(
                  (r) => r.default,
                )
                await new Promise<void>((res) => {
                  profileSession = new inspector.Session()
                  profileSession.connect()
                  profileSession.post('Profiler.enable', () => {
                    profileSession!.post('Profiler.start', () => {
                      server.config.logger.info('Profiler started')
                      res()
                    })
                  })
                })
              }
            },
          })
        }
        server.bindCLIShortcuts({ print: true, customShortcuts })
      } catch (e) {
        const logger = createLogger(options.logLevel)
        logger.error(
          colors.red(`error when starting dev server:\n${inspect(e)}`),
          {
            error: e,
          },
        )
        await stopProfiler(logger.info)
        process.exit(1)
      }
    },
  )

// build
cli
  .command('build [root]', 'build for production')
  .option(
    '--target <target>',
    `[string] transpile target (default: 'baseline-widely-available')`,
  )
  .option('--outDir <dir>', `[string] output directory (default: dist)`)
  .option(
    '--assetsDir <dir>',
    `[string] directory under outDir to place assets in (default: assets)`,
  )
  .option(
    '--assetsInlineLimit <number>',
    `[number] static asset base64 inline threshold in bytes (default: 4096)`,
  )
  .option(
    '--ssr [entry]',
    `[string] build specified entry for server-side rendering`,
  )
  .option(
    '--sourcemap [output]',
    `[boolean | "inline" | "hidden"] output source maps for build (default: false)`,
  )
  .option(
    '--minify [minifier]',
    `[boolean | "oxc" | "terser" | "esbuild"] enable/disable minification, ` +
      `or specify minifier to use (default: oxc)`,
  )
  .option('--manifest [name]', `[boolean | string] emit build manifest json`)
  .option('--ssrManifest [name]', `[boolean | string] emit ssr manifest json`)
  .option(
    '--emptyOutDir',
    `[boolean] force empty outDir when it's outside of root`,
  )
  .option('-w, --watch', `[boolean] rebuilds when modules have changed on disk`)
  .option('--app', `[boolean] same as \`builder: {}\``)
  .action(
    async (
      root: string,
      options: BuildEnvironmentOptions & BuilderCLIOptions & GlobalCLIOptions,
    ) => {
      filterDuplicateOptions(options)
      const { createBuilder } = await import('./build')

      /**
       * build 命令的参数分两层：
       * - --app 属于 Builder 编排层，决定是否启用多环境应用构建；
       * - target/outDir/sourcemap 等属于单个 build environment 的构建参数。
       */
      const buildOptions: BuildEnvironmentOptions = cleanGlobalCLIOptions(
        cleanBuilderCLIOptions(options),
      )

      try {
        const inlineConfig: InlineConfig = {
          root,
          base: options.base,
          mode: options.mode,
          configFile: options.config,
          configLoader: options.configLoader,
          logLevel: options.logLevel,
          clearScreen: options.clearScreen,
          build: buildOptions,
          ...(options.app ? { builder: {} } : {}),
        }
        /**
         * createBuilder 是 build 命令进入构建系统的总入口。
         * 它会基于 inlineConfig resolve 出环境配置，再由 buildApp 编排 client/ssr
         * 等环境的实际 Rolldown 构建流程。
         */
        const builder = await createBuilder(inlineConfig, null)
        await builder.buildApp()
        await builder.runDevTools()
      } catch (e) {
        createLogger(options.logLevel).error(
          colors.red(`error during build:\n${inspect(e)}`),
          { error: e },
        )
        process.exit(1)
      } finally {
        await stopProfiler((message) =>
          createLogger(options.logLevel).info(message),
        )
      }
    },
  )

// optimize
cli
  .command(
    'optimize [root]',
    'pre-bundle dependencies (deprecated, the pre-bundle process runs automatically and does not need to be called)',
  )
  .option(
    '--force',
    `[boolean] force the optimizer to ignore the cache and re-bundle`,
  )
  .action(
    async (root: string, options: { force?: boolean } & GlobalCLIOptions) => {
      filterDuplicateOptions(options)
      const { resolveConfig } = await import('./config')
      const { optimizeDeps } = await import('./optimizer')
      try {
        /**
         * optimize 是兼容保留的手动预构建命令。
         * 它仍按 serve 模式 resolveConfig，因为依赖优化服务的是 dev server 那套配置和插件环境。
         */
        const config = await resolveConfig(
          {
            root,
            base: options.base,
            configFile: options.config,
            configLoader: options.configLoader,
            logLevel: options.logLevel,
            mode: options.mode,
          },
          'serve',
        )
        await optimizeDeps(config, options.force, true)
      } catch (e) {
        createLogger(options.logLevel).error(
          colors.red(`error when optimizing deps:\n${inspect(e)}`),
          { error: e },
        )
        process.exit(1)
      }
    },
  )

// preview
cli
  .command('preview [root]', 'locally preview production build')
  .option('--host [host]', `[string] specify hostname`, { type: [convertHost] })
  .option('--port <port>', `[number] specify port`)
  .option('--strictPort', `[boolean] exit if specified port is already in use`)
  .option('--open [path]', `[boolean | string] open browser on startup`)
  .option('--outDir <dir>', `[string] output directory (default: dist)`)
  .action(
    async (
      root: string,
      options: {
        host?: string | boolean
        port?: number
        open?: boolean | string
        strictPort?: boolean
        outDir?: string
      } & GlobalCLIOptions,
    ) => {
      filterDuplicateOptions(options)
      const { preview } = await import('./preview')
      try {
        /**
         * preview 命令不会重新构建源码，只把 build.outDir 交给 preview 服务读取。
         * 因此 CLI 这里同时传 build.outDir 和 preview 端口/host/open，后续由 preview.ts
         * 把 dist 静态服务、HTML fallback 和快捷键串起来。
         */
        const server = await preview({
          root,
          base: options.base,
          configFile: options.config,
          configLoader: options.configLoader,
          logLevel: options.logLevel,
          mode: options.mode,
          build: {
            outDir: options.outDir,
          },
          preview: {
            port: options.port,
            strictPort: options.strictPort,
            host: options.host,
            open: options.open,
          },
        })
        server.printUrls()
        server.bindCLIShortcuts({ print: true })
      } catch (e) {
        createLogger(options.logLevel).error(
          colors.red(`error when starting preview server:\n${inspect(e)}`),
          { error: e },
        )
        process.exit(1)
      } finally {
        await stopProfiler((message) =>
          createLogger(options.logLevel).info(message),
        )
      }
    },
  )

cli.help()
cli.version(VERSION)

cli.parse()
