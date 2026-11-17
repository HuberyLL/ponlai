<!-- markdownlint-disable MD013 -->
# 空白项目

[English](README.md) | **简体中文**

在 Ponlai 渲染管线上开始你自己项目的起点：渲染管线的天空、海洋、光照和后处理，开阔海面上一块等你换成自己内容的岩石，以及截取、对比和测量画面的工具。复制它来开始一个项目，做法见仓库的 [README](https://github.com/HuberyLL/ponlai/blob/main/README.zh-CN.md#在你自己的项目中使用-ponlai)。

## 运行

`npm install` 之后，`npm run dev` 启动页面；打开 Vite 打印的地址。渲染管线的 URL 选项在页面上都能用，例如 `?paused&t=12` 或 `?weather=fair&hour=7`。

如果还要用工具，安装 Playwright 的浏览器和运行 Python 工具的 [uv](https://docs.astral.sh/uv/)，并把项目放进 git、至少提交一次（工具会读取它）：

```bash
npx playwright install chromium
curl -LsSf https://astral.sh/uv/install.sh | sh
git init && git add -A && git commit -m "Start from Ponlai's blank project"
```

要使用智能体技能，安装 Ponlai 的 Claude Code 插件（见 README 的[智能体技能](https://github.com/HuberyLL/ponlai/blob/main/README.zh-CN.md#智能体技能)）。

## 里面有什么

| 文件 | 作用 |
| --- | --- |
| `package.json` | 精确为 0.186.1 的 three.js（渲染管线会用到 three 的内部实现）、Vite、TypeScript 和 Playwright |
| `vite.config.ts` | 让 Vite 把渲染管线的 worker 构建为 ES 模块 |
| `tsconfig.json` | 允许渲染管线那些写明 `.ts` 文件的导入 |
| `index.html` | 页面：画布的容器和加载画面 |
| `src/main.ts` | 先装好页面的设置，再加载场景：渲染管线的模块在加载时读取设置 |
| `src/scene.ts` | 场景：一块岩石、它的地面和水，交给 `startScene` |
| `src/render/` | 渲染管线 |
| `src/looks/ponlai/` | Ponlai 的画面风格：小岛所用的光照、大气和画面参数 |
| `public/` | 云的形状噪声、星表、银河和月亮（[致谢](https://github.com/HuberyLL/ponlai/blob/main/CREDITS.md)的 Assets 一节） |
| `tools/kit/` | 工具（[它们的 README](https://github.com/HuberyLL/ponlai/blob/main/tools/kit/README.md)，英文） |
| `tools/project.mjs` | 工具针对本项目的配置 |

`startScene( host, options, content )` 按固定顺序运行渲染管线的各个阶段，并在阶段之间的槽位调用你的内容：`passes`、`ground`、`ambient` 和 `water` 为各阶段提供输入，可选的 `after...` 槽位加入你自己的物体。中性输入（`neutralFields`、`neutralBounceGround`、`neutralSeaLattice`、`neutralLattice`）为没有自己世界的场景描述一块平整的海底或地面。相机（`render.camera`）的垂直视场角是 27 度；在 `afterSky` 中摆放它。槽位和选项的说明在 `packages/render/assemble/StartScene.ts` 中，`app/scenes/` 里的测试场景是更完整的例子。要从别的地址加载资源，给 `startScene` 传入 `assetBase`。

## 选择画面风格

场景从两种画面风格之一开始，由 `src/scene.ts` 顶部的 `LOOK` 选择：

- `PONLAI_LOOK`（推荐，默认）：Ponlai 自己的曝光、雾、环境光、泛光和调色参数，按天气和时刻变化，与小岛所用的一致。
- `NEUTRAL_LOOK`：所有增益为 1，没有雾、泛光和调色。适合从零做你自己的画面风格，配合搭建画面风格和贴合参考图的技能使用。

两者的天空、太阳和海洋都是基于物理的；画面风格只设置它们周围的参数。

## 截图与对比

通过工具启动开发服务器：`serve.mjs` 在后台从 6400 起第一个空闲端口启动 Vite，并打印它的地址和停止它的命令。然后截取暂停场景的两张图并对比：

```bash
node tools/kit/serve.mjs dev
node tools/kit/gpu-lock.mjs run --shared -- node tools/kit/capture.mjs first --url http://127.0.0.1:6400/
node tools/kit/gpu-lock.mjs run --shared -- node tools/kit/capture.mjs second --url http://127.0.0.1:6400/
uv run tools/kit/img.py diff artifacts/captures/first.png artifacts/captures/second.png
```

两张截图逐字节一致。每个工具的说明见它的 `--help`。

## 已知限制

- 一个页面同一时间只能有一条渲染管线。要显示另一个场景，先对正在运行的场景调用 `dispose()`；之后的 `startScene` 会画得和全新加载时一样。
- Ponlai 只在 README 的[现状](https://github.com/HuberyLL/ponlai/blob/main/README.zh-CN.md#现状)一节列出的画质档位和天气下调校和检查。
- 渲染管线和工具不是 npm 包：你复制它们，更新时再复制一次。
