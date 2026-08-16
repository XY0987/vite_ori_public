# Vite 源码阅读注释版

这个仓库基于 Vite 源码整理，用于配合源码小册阅读和本地调试。它不是官方发布仓库，也不用于生产依赖分发；重点是帮助读者在真实源码里理解 Vite 的关键实现路径。

当前源码基线：`packages/vite` 为 Vite `8.1.0`。

## 仓库定位

这个仓库保留 Vite 原始 monorepo 结构，并在关键源码位置补充了中文注释和断点提示，方便读者把小册中的章节内容对应回真实实现。

重点覆盖：

- 配置加载、合并、历史 API 兼容和 `ResolvedConfig` 归一化
- 插件注册、排序、插件模板、环境级插件过滤和插件容器执行语义
- 依赖预构建的缓存判断、扫描、运行时发现和 Rolldown 预打包
- dev server 请求中间件、按需编译、缓存、etag 和 sourcemap 注入
- `importAnalysis`、CSS、asset、HTML proxy 等核心转换链路
- HMR 的服务端传播、WebSocket payload、客户端重新 import 和 accept 回调
- ModuleGraph、Environment API、多环境构建、preview server 边界

## 注释约定

源码里主要有两类辅助说明：

- `核心逻辑`：解释这段代码在 Vite 主流程里的职责、为什么这样设计，以及读源码时容易忽略的关键状态。
- `兼容逻辑`：解释历史 API、生态迁移、旧配置到新模型之间的桥接关系。

部分关键行还保留 `🔖断点[...]` 行内标记，用于配合小册中的推荐断点快速定位。

## 阅读建议

建议从 `packages/vite/src/node/config.ts` 的 `resolveConfig` 开始，先理解配置如何变成 `ResolvedConfig`，再按下面顺序阅读：

1. `packages/vite/src/node/plugins/index.ts`
2. `packages/vite/src/node/server/index.ts`
3. `packages/vite/src/node/server/transformRequest.ts`
4. `packages/vite/src/node/server/pluginContainer.ts`
5. `packages/vite/src/node/plugins/importAnalysis.ts`
6. `packages/vite/src/node/optimizer/`
7. `packages/vite/src/node/server/hmr.ts`
8. `packages/vite/src/node/server/moduleGraph.ts`
9. `packages/vite/src/node/build.ts`
10. `packages/vite/src/node/preview.ts`

配合调试时，可以在 Cursor/VS Code 中使用快速打开定位：macOS 按 `Command + P`，Windows/Linux 按 `Ctrl + P`，输入类似 `config.ts:1446` 的「文件名:行号」即可跳转。

## 上游项目

Vite 官方仓库：[vitejs/vite](https://github.com/vitejs/vite)

官方文档：[vite.dev](https://vite.dev)

## License

本仓库基于 Vite 源码，遵循原项目的 [MIT License](LICENSE)。
