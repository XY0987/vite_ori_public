import type { HotPayload, Update } from '#types/hmrPayload'
import type { ModuleNamespace, ViteHotContext } from '#types/hot'
import type { InferCustomEventPayload } from '#types/customEvent'
import type { NormalizedModuleRunnerTransport } from './moduleRunnerTransport'

type CustomListenersMap = Map<string, ((data: any) => void)[]>

interface HotModule {
  id: string
  callbacks: HotCallback[]
}

interface HotCallback {
  // the dependencies must be fetchable paths
  deps: string[]
  fn: (modules: Array<ModuleNamespace | undefined>) => void
}

export interface HMRLogger {
  error(msg: string | Error): void
  debug(...msg: unknown[]): void
}

export class HMRContext implements ViteHotContext {
  private newListeners: CustomListenersMap

  constructor(
    private hmrClient: HMRClient,
    private ownerPath: string,
  ) {
    if (!hmrClient.dataMap.has(ownerPath)) {
      hmrClient.dataMap.set(ownerPath, {})
    }

    // when a file is hot updated, a new context is created
    // clear its stale callbacks
    const mod = hmrClient.hotModulesMap.get(ownerPath)
    if (mod) {
      mod.callbacks = []
    }

    // clear stale custom event listeners
    const staleListeners = hmrClient.ctxToListenersMap.get(ownerPath)
    if (staleListeners) {
      for (const [event, staleFns] of staleListeners) {
        const listeners = hmrClient.customListenersMap.get(event)
        if (listeners) {
          hmrClient.customListenersMap.set(
            event,
            listeners.filter((l) => !staleFns.includes(l)),
          )
        }
      }
    }

    this.newListeners = new Map()
    hmrClient.ctxToListenersMap.set(ownerPath, this.newListeners)
  }

  get data(): any {
    return this.hmrClient.dataMap.get(this.ownerPath)
  }

  accept(deps?: any, callback?: any): void {
    if (typeof deps === 'function' || !deps) {
      // self-accept: hot.accept(() => {})
      this.acceptDeps([this.ownerPath], ([mod]) => deps?.(mod))
    } else if (typeof deps === 'string') {
      // explicit deps
      this.acceptDeps([deps], ([mod]) => callback?.(mod))
    } else if (Array.isArray(deps)) {
      this.acceptDeps(deps, callback)
    } else {
      throw new Error(`invalid hot.accept() usage.`)
    }
  }

  // export names (first arg) are irrelevant on the client side, they're
  // extracted in the server for propagation
  acceptExports(
    _: string | readonly string[],
    callback?: (data: any) => void,
  ): void {
    this.acceptDeps([this.ownerPath], ([mod]) => callback?.(mod))
  }

  dispose(cb: (data: any) => void): void {
    this.hmrClient.disposeMap.set(this.ownerPath, cb)
  }

  prune(cb: (data: any) => void): void {
    this.hmrClient.pruneMap.set(this.ownerPath, cb)
  }

  // Kept for backward compatibility (#11036)
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  decline(): void {}

  invalidate(message: string): void {
    const firstInvalidatedBy =
      this.hmrClient.currentFirstInvalidatedBy ?? this.ownerPath
    this.hmrClient.notifyListeners('vite:invalidate', {
      path: this.ownerPath,
      message,
      firstInvalidatedBy,
    })
    this.send('vite:invalidate', {
      path: this.ownerPath,
      message,
      firstInvalidatedBy,
    })
    this.hmrClient.logger.debug(
      `invalidate ${this.ownerPath}${message ? `: ${message}` : ''}`,
    )
  }

  on<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void {
    const addToMap = (map: Map<string, any[]>) => {
      const existing = map.get(event) || []
      existing.push(cb)
      map.set(event, existing)
    }
    addToMap(this.hmrClient.customListenersMap)
    addToMap(this.newListeners)
  }

  off<T extends string>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void {
    const removeFromMap = (map: Map<string, any[]>) => {
      const existing = map.get(event)
      if (existing === undefined) {
        return
      }
      const pruned = existing.filter((l) => l !== cb)
      if (pruned.length === 0) {
        map.delete(event)
        return
      }
      map.set(event, pruned)
    }
    removeFromMap(this.hmrClient.customListenersMap)
    removeFromMap(this.newListeners)
  }

  send<T extends string>(event: T, data?: InferCustomEventPayload<T>): void {
    this.hmrClient.send({ type: 'custom', event, data })
  }

  private acceptDeps(
    deps: string[],
    callback: HotCallback['fn'] = () => {},
  ): void {
    const mod: HotModule = this.hmrClient.hotModulesMap.get(this.ownerPath) || {
      id: this.ownerPath,
      callbacks: [],
    }
    mod.callbacks.push({
      deps,
      fn: callback,
    })
    this.hmrClient.hotModulesMap.set(this.ownerPath, mod)
  }
}

export class HMRClient {
  public hotModulesMap: Map<string, HotModule> = new Map()
  public disposeMap: Map<string, (data: any) => void | Promise<void>> =
    new Map()
  public pruneMap: Map<string, (data: any) => void | Promise<void>> = new Map()
  public dataMap: Map<string, any> = new Map()
  public customListenersMap: CustomListenersMap = new Map()
  public ctxToListenersMap: Map<string, CustomListenersMap> = new Map()
  public currentFirstInvalidatedBy: string | undefined

  constructor(
    public logger: HMRLogger,
    private transport: NormalizedModuleRunnerTransport,
    // This allows implementing reloading via different methods depending on the environment
    private importUpdatedModule: (update: Update) => Promise<ModuleNamespace>,
  ) {}

  public async notifyListeners<T extends string>(
    event: T,
    data: InferCustomEventPayload<T>,
  ): Promise<void>
  public async notifyListeners(event: string, data: any): Promise<void> {
    const cbs = this.customListenersMap.get(event)
    if (cbs) {
      await Promise.allSettled(cbs.map((cb) => cb(data)))
    }
  }

  public send(payload: HotPayload): void {
    this.transport.send(payload).catch((err) => {
      this.logger.error(err)
    })
  }

  public clear(): void {
    this.hotModulesMap.clear()
    this.disposeMap.clear()
    this.pruneMap.clear()
    this.dataMap.clear()
    this.customListenersMap.clear()
    this.ctxToListenersMap.clear()
  }

  // After an HMR update, some modules are no longer imported on the page
  // but they may have left behind side effects that need to be cleaned up
  // (e.g. style injections)
  /**
   * 服务端发来 prune paths 后，客户端按路径清理模块副作用。
   * dispose 先处理“模块被替换/废弃前”的清理，prune 再处理“模块已经不再被导入”的清理。
   */
  public async prunePaths(paths: string[]): Promise<void> { // 🔖断点[小册08·客户端] prune:清理已不再被页面导入模块的副作用
    await Promise.all(
      paths.map((path) => {
        const disposer = this.disposeMap.get(path)
        if (disposer) return disposer(this.dataMap.get(path))
      }),
    )
    await Promise.all(
      paths.map((path) => {
        const fn = this.pruneMap.get(path)
        if (fn) {
          return fn(this.dataMap.get(path))
        }
      }),
    )
  }

  protected warnFailedUpdate(err: Error, path: string | string[]): void {
    if (!(err instanceof Error) || !err.message.includes('fetch')) {
      this.logger.error(err)
    }
    this.logger.error(
      `Failed to reload ${path}. ` +
        `This could be due to syntax errors or importing non-existent ` +
        `modules. (see errors above)`,
    )
  }

  private updateQueue: Promise<(() => void) | undefined>[] = []
  private pendingUpdateQueue = false

  /**
   * 把同一次源码变更触发的多个 hot update 先缓存在队列里。
   * 当前微任务结束后统一 Promise.all 拉取新模块，再按服务端发送顺序执行回调，
   * 避免多个 HTTP import 往返时间不同导致回调执行顺序错乱。
   */
  public async queueUpdate(payload: Update): Promise<void> { // 🔖断点[小册08·客户端] 同批 update 先入队，微任务后统一拉取并按序回调
    this.updateQueue.push(this.fetchUpdate(payload))
    if (!this.pendingUpdateQueue) {
      this.pendingUpdateQueue = true
      await Promise.resolve()
      this.pendingUpdateQueue = false
      const loading = [...this.updateQueue]
      this.updateQueue = []
      ;(await Promise.all(loading)).forEach((fn) => fn && fn())
    }
  }

  private async fetchUpdate(update: Update): Promise<(() => void) | undefined> {
    const { path, acceptedPath, firstInvalidatedBy } = update
    const mod = this.hotModulesMap.get(path)
    if (!mod) {
      // In a code-splitting project,
      // it is common that the hot-updating module is not loaded yet.
      // https://github.com/vitejs/vite/issues/721
      return
    }

    let fetchedModule: ModuleNamespace | undefined
    const isSelfUpdate = path === acceptedPath

    /**
     * 先筛出会被本次 acceptedPath 命中的 accept 回调，再重新 import 模块。
     * 这样即使 import 失败，也不会误触发不相关的回调。
     */
    const qualifiedCallbacks = mod.callbacks.filter(({ deps }) =>
      deps.includes(acceptedPath),
    )

    if (isSelfUpdate || qualifiedCallbacks.length > 0) {
      const disposer = this.disposeMap.get(acceptedPath)
      if (disposer) await disposer(this.dataMap.get(acceptedPath))
      try {
        /**
         * 用带 ?t= 时间戳的 URL 重新 import 改动模块。
         * 时间戳绕过浏览器 ESM 缓存，保证拿到服务端刚重新 transform 后的代码。
         */
        fetchedModule = await this.importUpdatedModule(update) // 🔖断点[小册08·客户端] 用带时间戳的 URL 重新 import 最新模块
      } catch (e) {
        this.warnFailedUpdate(e, acceptedPath)
      }
    }

    /**
     * fetchUpdate 返回的是一个延迟执行函数。
     * queueUpdate 会先把所有新模块拉取完成，再统一执行回调，避免多个更新之间读到半新半旧的模块状态。
     */
    return () => { // 🔖断点[小册08·客户端] 所有新模块拉取完成后才执行 accept 回调
      try {
        this.currentFirstInvalidatedBy = firstInvalidatedBy
        for (const { deps, fn } of qualifiedCallbacks) {
          fn(
            deps.map((dep) =>
              dep === acceptedPath ? fetchedModule : undefined,
            ),
          )
        }
        const loggedPath = isSelfUpdate ? path : `${acceptedPath} via ${path}`
        this.logger.debug(`hot updated: ${loggedPath}`)
      } finally {
        this.currentFirstInvalidatedBy = undefined
      }
    }
  }
}
