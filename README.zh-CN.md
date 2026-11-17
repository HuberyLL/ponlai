<!-- markdownlint-disable MD013 MD033 MD041 -->
<div align="center">

<!-- HEADER IMAGE: the header image's GitHub attachment link goes here. -->

# Ponlai

**基于物理的浏览器渲染管线，用来做电影级的游戏画面。**

[English](README.md) | **简体中文**

[![Check](https://github.com/HuberyLL/ponlai/actions/workflows/check.yml/badge.svg)](https://github.com/HuberyLL/ponlai/actions/workflows/check.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![three.js r186](https://img.shields.io/badge/three.js-r186-black?logo=threedotjs)](https://threejs.org/)
[![WebGPU](https://img.shields.io/badge/WebGPU-required-005a9c)](https://www.w3.org/TR/webgpu/)
[![Node.js 26](https://img.shields.io/badge/Node.js-26-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>
<!-- markdownlint-enable MD033 -->

Ponlai 是一套基于物理的 Web 渲染管线，基于 three.js 和 WebGPU 开发。本仓库用它渲染了一座大海中的小岛：清澈的深水、嶙峋的礁石、随风起伏的草甸，全部由基于物理的太阳和天空照明。
画面追求东方美学的意境，灵感来自《对马岛之魂》。

## 功能

### 渲染

- **海洋**：FFT 波浪、近岸浪、泡沫、折射、屏幕空间反射
- **天空**：基于物理的大气、体积云和云影、昼夜循环，以及使用真实星表、带月亮的夜空
- **光照**：柔和的太阳阴影、环境光探针、地面反弹光、分簇局部光源、GTAO、体积光
- **雾**：随距离和高度变化的体积雾
- **植被**：带 LOD 的实例化植物，随风摆动
- **后处理**：带浦肯野效应的自动曝光、局部色调映射、LUT 调色、基于物理的泛光、TAA 或 MSAA、FSR 超分、动态分辨率

### 为 AI 自主迭代而生

- **可复现的画面**：暂停的页面每次加载都渲染出同一帧（误差在实测范围内）。智能体改完后对比截图，就能自己证明改动只改了该改的地方。
- **工具**：截图、对比截图、测量帧时间、按渲染 Pass 拆分 GPU 耗时，智能体都能自己完成，不需要人盯着屏幕。
- **技能**：写给智能体的工作流程，从做出画面风格、对照参考图调整，到验证改动、测性能、排查问题。
- **帧图（Frame Graph）**：每个渲染 Pass 都声明自己读写哪些渲染目标，智能体增加或修改一个 Pass 时不会弄坏其他 Pass。

## 为什么做 Ponlai

Ponlai 希望让每个和 AI 编程智能体一起工作的人，都能做出 3A 游戏和电影水准的游戏画面。渲染管线给智能体一个基于物理的基础，技能教它做游戏画面的完整方法，从美术到工程，工具让它能看到、对比和测量自己的成果，从而自己检查自己的工作。

## 现状

Ponlai 目前只在高画质预设、原生 4K 分辨率、晴天和少云天气下，从白天、日落到夜晚的全天各个时刻调校和测试。其他画质预设（`medium`、`low`）和天气（`cloudy`、`overcast`、`rain`、`storm`、`fog`）仍然可以加载，但最近没有调校，画面可能更差，运行也可能更慢。`?game` 会在岛上打开一个早期的游戏原型。

## 快速开始

你需要 Node.js 26，以及支持 WebGPU 的浏览器，比如较新版本的 Chrome 或 Edge。

```bash
git clone https://github.com/HuberyLL/ponlai.git
cd ponlai
npm ci
npm run dev
```

然后打开 <http://127.0.0.1:5190/>。开发服务器第一次启动时，会把资源（贴图、天空数据、角色）下载到 `public/` 目录，这个目录不进 git。

可以试试这些页面：

| 地址 | 你会看到 |
| --- | --- |
| <http://127.0.0.1:5190/?weather=fair&preset=sunset> | 少云天气下日落时的小岛 |
| <http://127.0.0.1:5190/?paused&t=12> | 暂停在第 12 秒的场景，和工具截图时一样 |
| <http://127.0.0.1:5190/?game> | 游戏原型 |
| <http://127.0.0.1:5190/scenes.html?scene=ball> | 没有小岛的测试场景（`ball`、`empty`、`sea` 或 `plants`） |

全部选项见 [URL 选项](docs/reference/url-options.md)（英文）。

## 在你自己的项目中使用 Ponlai

要开始一个新项目，复制[空白项目](templates/blank/README.zh-CN.md)就行。它是一个最小场景：天空、海洋、光照和后处理，中间一块等你替换的礁石，工具已经配好，资源也都带上了。在你克隆下来的仓库里运行：

```bash
node tools/repo/assets.mjs pull
cp -RL templates/blank ~/my-project
cd ~/my-project
npm install
npm run dev
```

`cp -RL` 会跟随模板里的符号链接，所以复制出来的项目自带渲染管线、工具和资源，可以独立运行。它的 README 会介绍每个文件、怎么选择画面风格，以及怎么配置工具。

要在已有项目里使用这些工具，请看[工具的 README](tools/kit/README.md)（英文）。智能体技能在任何项目里都能用（[见下文](#智能体技能)）。

如果想参与 Ponlai 本身的开发，[贡献指南](.github/CONTRIBUTING.md)（英文）列出了检查和工具额外需要的程序。

### 智能体技能

每个技能都是一套通用的工作流程，适用于任何项目；你项目自己的具体信息写在旁边单独的绑定文件里（本仓库的在 `docs/bindings/`）。其中两个技能和画面风格有关：

- [电影感风格化写实](skills/building-cinematic-stylised-realism/SKILL.md)：在不破坏基于物理渲染的前提下做出风格化的画面。材质保持写实，风格通过内容、按天气和时段调整的少量全局光照参数，以及后处理来实现。
- [按参考图调整画面](skills/fitting-a-look-to-reference-images/SKILL.md)：调整曝光、光照、雾和调色，让渲染结果和你自己的参考图一致。

其余技能涉及验证改动、测量性能、排查画面瑕疵和每次运行结果不一致的画面，以及编写着色器、工具和文档（见[文档索引](docs/README.md)中的 Skills 一节）。技能本身是英文的。

在 Claude Code 中安装：

```bash
claude plugin marketplace add HuberyLL/ponlai --sparse .claude-plugin plugins skills
claude plugin install ponlai@ponlai
```

用 `claude plugin marketplace update ponlai` 更新。其他智能体的话，把技能的文件夹复制到该智能体的技能目录即可。无论用哪种方式，都要参照本仓库的绑定文件，按相同的章节写一份你自己的。

## 项目结构

代码按层组织，从下到上依次是：渲染管线（`packages/render/`）、小岛（`packages/island/`）、游戏（`packages/game/`）和应用（`app/`）。每一层只从它下面的层导入。[架构文档](ARCHITECTURE.md)介绍了各层、数据在层间如何流动，以及跨层的规则；[文档索引](docs/README.md)列出了所有页面。文档都是英文的。

## 参与贡献

提问和分享想法请到 [Discussions](https://github.com/HuberyLL/ponlai/discussions)，报告 bug 和提需求请开 issue，中文或英文都可以。[贡献指南](.github/CONTRIBUTING.md)介绍了如何搭建环境和提交改动，所有参与者都要遵守[行为准则](.github/CODE_OF_CONDUCT.md)。报告安全问题请看[安全策略](.github/SECURITY.md)。

## 许可证

Ponlai 以 [MIT 许可证](LICENSE)发布。[致谢](CREDITS.md)列出了第三方代码和资源及其许可证。
