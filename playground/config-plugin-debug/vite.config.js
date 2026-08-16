import { resolve } from 'node:path'
import { defineConfig, perEnvironmentPlugin } from 'vite'
import { debugOptions } from './debug-options.js'

const dirname = import.meta.dirname
const isMainModule = (id) => id.endsWith('/config-plugin-debug/main.js')

function createTracePlugin(name, options = {}) {
  return {
    name,
    enforce: options.enforce,
    apply: options.apply,

    config: {
      order: options.configOrder,
      handler(config, env) {
        console.log(`[config] ${name}`, {
          command: env.command,
          mode: env.mode,
          currentBase: config.base,
        })
        return {
          define: {
            [`__${name.replaceAll(/[^a-z\d]/gi, '_').toUpperCase()}__`]:
              JSON.stringify(true),
          },
        }
      },
    },

    configEnvironment(environmentName) {
      console.log(`[configEnvironment] ${name} -> ${environmentName}`)
    },

    configResolved(config) {
      console.log(`[configResolved] ${name}`, {
        base: config.base,
        environments: Object.keys(config.environments),
      })
    },

    transform: {
      order: options.transformOrder,
      handler(code, id) {
        if (!isMainModule(id)) return
        console.log(`[transform] ${name}`)
        return `${code}\n// transformed by ${name}`
      },
    },
  }
}

const environmentPlugin = perEnvironmentPlugin(
  'debug:per-environment',
  (environment) => {
    if (environment.name === 'client') {
      return {
        name: 'debug:client-only',
        transform(code, id) {
          if (!isMainModule(id)) return
          console.log('[transform] debug:client-only')
          return `${code}\n// transformed for client`
        },
      }
    }

    if (environment.name === 'ssr') {
      return {
        name: 'debug:ssr-only',
        transform(code, id) {
          if (!isMainModule(id)) return
          console.log('[transform] debug:ssr-only')
          return `${code}\n// transformed for ssr`
        },
      }
    }

    return false
  },
)

export default defineConfig(({ command, mode }) => {
  console.log('[vite.config factory]', { command, mode })

  return {
    ...debugOptions,
    resolve: {
      alias: {
        '@debug': resolve(dirname, 'src'),
      },
    },
    plugins: [
      createTracePlugin('debug:pre', { enforce: 'pre' }),
      createTracePlugin('debug:normal', { transformOrder: 'pre' }),
      createTracePlugin('debug:serve-command', { apply: 'serve' }),
      createTracePlugin('debug:build-command', { apply: 'build' }),
      createTracePlugin('debug:post', { enforce: 'post' }),
      environmentPlugin,
    ],
  }
})
