<!-- markdownlint-disable MD013 MD033 MD041 -->
<div align="center">

<!-- HEADER IMAGE: the header image's GitHub attachment link goes here. -->

# Ponlai

**一条基于物理的渲染管线，在浏览器里做电影级的游戏画面。**

[English](README.md) | **简体中文**

[![Check](https://github.com/HuberyLL/ponlai/actions/workflows/check.yml/badge.svg)](https://github.com/HuberyLL/ponlai/actions/workflows/check.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![three.js r186](https://img.shields.io/badge/three.js-r186-black?logo=threedotjs)](https://threejs.org/)
[![WebGPU](https://img.shields.io/badge/WebGPU-required-005a9c)](https://www.w3.org/TR/webgpu/)
[![Node.js 26](https://img.shields.io/badge/Node.js-26-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>
<!-- markdownlint-enable MD033 -->

Ponlai 是一条运行在浏览器里的基于物理的渲染管线，构建在 three.js 和 WebGPU 之上。本仓库用一座开阔海面上的小岛来展示它：清澈见底的深水、厚重的岩石、随风摆动的草甸，由太阳和天空照亮。
画面追求东方美学的意境，灵感来自《对马岛之魂》。

## 功能

### 能画什么

- **海洋**：FFT 波浪、近岸浪、泡沫、折射、海面反射与屏幕空间反射
- **天空**：物理大气、体积云及其投影、昼夜循环、带星表和月亮的夜空
- **光照**：柔和的太阳阴影、环境光探针、地面反弹光、分簇局部光源、GTAO、光束
- **大气**：随距离和高度变化的体积雾
- **植被**：带细节层级（LOD）的实例化植物，随风摆动
- **画面**：带浦肯野效应的自动曝光、局部色调映射、调色 LUT、物理泛光、TAA 或 MSAA、FSR 超分、动态分辨率

### 为 AI 智能体而建

- **可重复的帧**：暂停的页面每次加载都画出同一帧（在实测的容差内），所以一项改动可以通过对比截图来证明。
- **工具**：截取、对比和测量画面，并把一帧的 GPU 时间按渲染通道拆开。
- **技能**：灯光美术和图形工程师的工作方法，从搭建画面风格到验证一项改动。
- **帧图**：每个渲染通道都声明它读取和写入的目标。

## 为什么做 Ponlai

Ponlai 的目标是让每个用 AI 编程智能体工作的人，都能做出 3A 游戏和电影品质的游戏画面。渲染管线给智能体一个基于物理的底座，技能给它灯光美术和图形工程师的工作方法，工具让它看见、对比和测量自己做出的东西，从而能检查自己的工作。

## 现状

Ponlai 在高画质档位、4K 输出（1920x1080 CSS 像素，设备像素比 2）、晴朗和少云两种天气下调校和检查。其他画质档位（`medium`、`low`）和天气（`cloudy`、`overcast`、`rain`、`storm`、`fog`）仍在代码中，也能加载，但近期没有调校，画面和开销可能落后。`?game` 打开岛上一个早期的游戏原型。

## 快速开始

你需要一个支持 WebGPU 的浏览器（例如最新的 Chrome 或 Edge），以及 Node.js 26 和 npm。

```bash
git clone https://github.com/HuberyLL/ponlai.git
cd ponlai
npm ci
npm run dev
```

然后打开 <http://127.0.0.1:5190/>。开发服务器第一次启动时，会把资源（纹理、天空星表、角色）下载到被 git 忽略的 `public/` 文件夹。

可以试试这些页面：

| 地址 | 显示的内容 |
| --- | --- |
| <http://127.0.0.1:5190/?weather=fair&preset=sunset> | 少云天气下日落时的小岛 |
| <http://127.0.0.1:5190/?paused&t=12> | 暂停在第 12 秒的场景，和工具截图时一样 |
| <http://127.0.0.1:5190/?game> | 游戏原型 |
| <http://127.0.0.1:5190/scenes.html?scene=ball> | 不含小岛的测试场景（`ball`、`empty`、`sea` 或 `plants`） |

[URL 选项](docs/reference/url-options.md)列出了全部选项（英文）。

## 在你自己的项目中使用 Ponlai

要开始一个项目，复制[空白项目](templates/blank/README.zh-CN.md)：渲染管线的天空、海洋、光照和后处理，围绕一块等你替换的岩石，并附带工具（已配置好）和资源。在快速开始克隆下来的仓库里运行：

```bash
node tools/repo/assets.mjs pull
cp -RL templates/blank ~/my-project
cd ~/my-project
npm install
npm run dev
```

复制会跟随模板里的链接，把渲染管线、工具和资源一起带走，复制出的项目可以独立安装和运行。它的 README 说明每个文件的作用、如何选择画面风格，以及如何配置工具。

要把工具加到已有的项目里，按照[工具包的 README](tools/kit/README.md)（英文）操作。智能体技能可以用在任何项目中（见[下文](#智能体技能)）。

要参与 Ponlai 本身的开发，[贡献指南](.github/CONTRIBUTING.md)（英文）列出了检查和工具在快速开始之外还需要的程序。

### 智能体技能

每个技能都是一套适用于任何项目的方法；项目自己的事实写在它旁边的一页绑定文档里（本仓库的在 `docs/bindings/`）。其中两个用来做画面：

- [搭建风格化写实画面](skills/building-cinematic-stylised-realism/SKILL.md)：让材质和光照保持物理上可信，把风格放在内容、每种天气和时刻的少数几个全局光照值，以及画面处理上。
- [让画面贴合参考图](skills/fitting-a-look-to-reference-images/SKILL.md)：找出让一帧画面贴近你自己的参考图的光照、大气和画面参数。

其余技能用来验证改动、测量帧时间、查找画面缺陷或帧不可重复的原因，以及编写着色器、工具和文档（[文档索引](docs/README.md)的 Skills 一节）。技能本身是英文的。

在 Claude Code 中安装：

```bash
claude plugin marketplace add HuberyLL/ponlai --sparse .claude-plugin plugins skills
claude plugin install ponlai@ponlai
```

用 `claude plugin marketplace update ponlai` 更新。用其他智能体时，把技能的文件夹复制到该智能体的技能文件夹。无论哪种方式，都要按本仓库绑定文档的章节写一页你自己的绑定文档。

## 结构

代码分层，从低到高：渲染管线（`packages/render/`）、小岛（`packages/island/`）、游戏（`packages/game/`）和页面（`app/`）。每一层只从它下面的层导入。[架构](ARCHITECTURE.md)描述各层、数据流和跨层规则，[文档索引](docs/README.md)列出了每一页。文档都是英文的。

## 参与贡献

问题和想法请发到 [Discussions](https://github.com/HuberyLL/ponlai/discussions)，缺陷和需求请提 issue，中文或英文都可以。[贡献指南](.github/CONTRIBUTING.md)说明如何配置环境和提交改动，所有参与者都遵守[行为准则](.github/CODE_OF_CONDUCT.md)。安全问题请按[安全策略](.github/SECURITY.md)报告。

## 许可证

Ponlai 以 [MIT 许可证](LICENSE)发布。[致谢](CREDITS.md)列出了第三方代码和资源及其许可证。
