# Vite 8.1.0 源码导读（配套《Vite：从使用到精通》第二阶段·源码篇）

> 这份导读不是又一份源码讲解，而是一张「**去哪打断点**」的地图。配合小册第二阶段每一节使用：打开对应小节 → 按下表在本仓库打断点 → 用 `.vscode/launch.json` 启动 → 跟真实流程。
>
> 源码基线：本仓库 `packages/vite/package.json` → `8.1.0`。所有路径相对仓库根目录，所有行号以 8.1.0 为准。

## 快速开始

```bash
pnpm install
pnpm --filter=./packages/vite run build       # 首次需构建一次产物(断点靠 sourcemap)
# 然后在 VS Code 选择 "Vite Dev: playground/html" 按 F5
```

`.vscode/launch.json` 已内置三个配置：

- **Vite Dev: playground/html** —— 以自带的极简项目为靶子调 dev；
- **Vite Dev: 你的项目** —— 把 `cwd` 改成你自己的项目路径；
- **Vite Build: playground/html** —— 调 `vite build`。

> 调试入口是 `packages/vite/bin/vite.js`，它加载的是 `dist/node/cli.js`（构建产物）。断点能停在 `.ts` 源码上，靠的是产物 sourcemap + `bin/vite.js` 主动开启的 `process.setSourceMapsEnabled(true)`。改了 `src` 要重新 build（或开 `pnpm --filter=./packages/vite run dev` watch）才生效。

## 断点已在源码里标注好了

为方便阅读，每个推荐断点都已在源码对应行**行尾**加了一条带说明的注释，统一以 `🔖断点` 开头，例如：

```ts
const loadResult = await loadConfigFromFile( // 🔖断点[小册02] 加载配置文件：解析到哪个 vite.config、用哪种 loader(默认 bundle/Rolldown)
```

所以你不必死记行号——在编辑器里**全局搜索 `🔖断点`** 就能列出全部断点位置；想只看某一节的，搜 `🔖断点[小册08]` 之类即可。这些注释加在行尾，不改变任何行号，与小册正文给出的行号完全一致。

> 这些 `🔖断点` 注释是配套学习用的标注，并非 Vite 原始源码的一部分。若想还原干净源码，`git checkout .` 即可。

## 小节 ↔ 源码入口 ↔ 推荐断点

| 小节                          | 主入口文件                                                                 | 推荐断点（file:line）                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 00 源码全景与模块关系         | `packages/vite/src`（先读小册 00 节建立全景，无需断点）                    | —                                                                                                                                            |
| 01 环境准备与调试入门         | `packages/vite/bin/vite.js`、`src/node/cli.ts`                             | `server/transformRequest.ts:78`                                                                                                              |
| 02 配置加载与归一化           | `src/node/config.ts`                                                       | `config.ts:1446`、`config.ts:1455`、`config.ts:2435`、`config.ts:2658`、`config.ts:1488`、`config.ts:2117`                                   |
| 03 插件注册与排序             | `src/node/plugins/index.ts`、`src/node/config.ts`                          | `config.ts:1478`、`config.ts:1482`、`plugins/index.ts:89`、`plugin.ts:396`、`plugins/index.ts:212`                                           |
| 04 依赖预构建                 | `src/node/optimizer/`                                                      | `optimizer/optimizer.ts:157`、`optimizer/index.ts:420`、`optimizer/index.ts:841`、`optimizer/optimizer.ts:563`、`optimizer/optimizer.ts:372` |
| 05 按需编译与请求处理         | `src/node/server/transformRequest.ts`                                      | `server/middlewares/transform.ts:257`、`transformRequest.ts:172`、`transformRequest.ts:269`、`transformRequest.ts:358`、`server/send.ts:50`  |
| 06 核心转换链路               | `src/node/plugins/importAnalysis.ts`、`plugins/css.ts`、`plugins/asset.ts` | `importAnalysis.ts:280`、`importAnalysis.ts:769`、`css.ts:433`、`css.ts:606`、`pluginContainer.ts:604`                                       |
| 07 插件容器 PluginContainer   | `src/node/server/pluginContainer.ts`                                       | `pluginContainer.ts:436`、`pluginContainer.ts:515`、`pluginContainer.ts:585`、`pluginContainer.ts:373`                                       |
| 08 HMR 实现原理               | `src/node/server/hmr.ts`、`server/ws.ts`、`src/client/client.ts`           | `server/index.ts:913`、`hmr.ts:411`、`hmr.ts:855`、`hmr.ts:781`、`ws.ts:387`、（客户端）`client/client.ts:206`、`shared/hmr.ts:286`          |
| 09 模块图与依赖追踪           | `src/node/server/moduleGraph.ts`、`server/mixedModuleGraph.ts`             | `moduleGraph.ts:343`、`moduleGraph.ts:252`、`moduleGraph.ts:166`、`mixedModuleGraph.ts:505`、`server/index.ts:590`                           |
| 10 多环境模型 Environment API | `src/node/server/environment.ts`、`baseEnvironment.ts`                     | `server/index.ts:572`、`environment.ts:138`、`environment.ts:216`、`environment.ts:229`、`server/index.ts:590`                               |
| 11 构建阶段：驱动 Rolldown    | `src/node/build.ts`                                                        | `build.ts:831`、`build.ts:894`、`build.ts:898`、`build.ts:635`、`utils.ts:1278`、`build.ts:1831`                                             |
| 12 preview server 边界        | `src/node/preview.ts`                                                      | `preview.ts:134`、`preview.ts:249`、`server/middlewares/indexHtml.ts:535`                                                                    |

## 专题 · 底层引擎与生态对比（实现层）↔ 源码锚点

> 对应小册第二阶段第二部分。这条暗线讲「双引擎 → 单引擎」：esbuild/Rollup 如何被 Rolldown(内嵌 Oxc) 收敛。搜 `🔖断点[专题` 可列出全部锚点。

| 专题小节 | 主入口文件 | 推荐断点（file:line） |
| --- | --- | --- |
| 专题01 双引擎的历史与代价 | `src/node/plugins/esbuild.ts`、`build.ts` | `build.ts:540`（esbuild 唯一干活点 `minify:'esbuild'`）、`plugins/esbuild.ts:278`（`esbuildPlugin` 已不再注册）、`plugins/esbuild.ts:99`（`transformWithEsbuild` 弃用） |
| 专题02 Rollup vs Rolldown | `src/node/build.ts`、`utils.ts`、`optimizer/index.ts` | `build.ts:894`（build 调 `rolldown()`）、`optimizer/index.ts:841`（dev 预构建调 `rolldown()`）、`config.ts:2435`（配置打包调 `rolldown()`）、`utils.ts:1268`（`rollupOptions↔rolldownOptions` 代理） |
| 专题03 Oxc 工具链与边界 | `src/node/plugins/oxc.ts`、`plugins/index.ts`、`build.ts`、`config.ts` | `plugins/oxc.ts:210`（`vite:oxc` 转译插件）、`plugins/index.ts:126`（开关 `config.oxc`）、`build.ts:452`（默认 `minify:'oxc'`）、`config.ts:1931`（`esbuild`→`oxc` 配置迁移） |
| 专题04 生态连带影响 | `src/node/optimizer/pluginConverter.ts`、`config.ts` | `config.ts:1380`（esbuild 插件转 Rolldown 插件的调用点）、`optimizer/pluginConverter.ts:31`（转换器本体） |

## 一次完整 dev 请求的链路（速记）

```
bin/vite.js → cli.ts(createServer) → server/index.ts(_createServer)
  → config.ts(resolveConfig) → 创建 environments + 中间件 + ws
  → server.listen() → 各环境 depsOptimizer.init()(optimizer/)
浏览器请求模块:
  transformMiddleware → environment.transformRequest
    → transformRequest.ts(doTransform → loadAndTransform)
      → pluginContainer.resolveId / load / transform
        → importAnalysis / css / asset 等内置插件
      → moduleGraph.updateModuleTransformResult(缓存+etag)
    → send.ts(写回浏览器)
改文件:
  watcher → hmr.ts(handleHMRUpdate → propagateUpdate) → ws.ts(send)
    → client/client.ts(handleMessage → fetchUpdate ?t=)
```

## 常用调试开关

```bash
# 内部 debug 日志(bin/vite.js 会把 --debug xxx 翻译成 DEBUG=vite:xxx)
node packages/vite/bin/vite.js --debug
DEBUG=vite:resolve,vite:transform,vite:hmr node packages/vite/bin/vite.js
DEBUG=vite:deps node packages/vite/bin/vite.js            # 依赖预构建
```

> 提示：每次断点停下，先看左侧 CALL STACK——它就是一条经过验证的真实调用链。小册里给出的所有调用链，本质都是这样一帧帧看出来的。
