<div align="center">

# 贵傩戏 · 傩文化数字博物馆

**GUI NUO OPERA · 数字展陈交互体验**
Nuo Culture Digital Museum

贵州傩戏面具的三维点云数字展馆 —— 纯浏览器运行，裸手手势交互

[在线体验](https://kingkazmax.github.io/nuo-culture-digital-museum/) · [交互说明](docs/交互说明.md) · [性能与资产](docs/性能与资产.md)

</div>

---

## Overview · 概览

傩，是上古驱疫纳吉的仪式，傩戏被誉为「中国戏剧的活化石」，傩面具雕刻与傩戏表演是贵州最具代表性的非物质文化遗产之一。传统傩戏展演需要戏台、锣鼓与特定节庆场景，难以走进当代人的日常视野——本项目尝试回应这一困境。

「贵傩戏 · 傩文化数字博物馆」是一座开在浏览器里的展馆：五面贵州傩戏面具以每面 65,536 点的实时点云陈列于黑白灰的数字展厅，配合双层背景星云与衬线展签版式。观展不隔玻璃：手掌移动即可旋转藏品，捏合切换展品，握拳令傩面爆散为星尘；也可以对着麦克风提问，听展馆讲述傩的历史与形制。无需安装任何应用，打开网页即可观展。

- **让非遗「可及」**：一个链接即可观展，突破地域与展演场景限制
- **让非遗「可玩」**：手势与语音参与式观展，在互动中建立情感联结
- **让非遗「可存」**：65,536 点/面的三维点云为面具建立可精确度量的数字档案
- **让非遗「可传」**：全部开源，支持上传自有模型扩展馆藏，可作美育课件、数字展厅与形态研究素材

## Highlights · 展陈亮点

- **五面点云傩面**：真实傩戏面具经高精度同步采集为点云（65,536 点/面，gzip 压缩传输，单面约 1.1–1.25 MB），加载后浏览器流畅展陈
- **裸手手势交互**：MediaPipe 本地推理——手掌移动旋转面具、捏合切换藏品、握拳令傩面爆散为星尘、双手拉距缩放，画面不出本机
- **语音科普问答**：麦克风说出问题，展馆匹配知识库并播放对应讲解（17 个主题），识别与播放全离线
- **展厅背景音乐**：127 秒循环配乐（归零《魔鬼花园》2026 重录版），首次交互后自动开始，音量可调
- **展签文案实时编辑**：双击画面文字即可就地修改主标题与副题，六款离线中文字体可换
- **自有模型入馆**：上传 `.ply / .glb / .gltf / .obj` 即时转为点云加入切换序列，IndexedDB 本地持久化
- **黑白灰馆舍 UI**：纸白铭牌、衬线展签、印章红点缀的黑白灰视觉，契合数字非遗的气质

## Interactions · 交互速览

| 操作 | 方式 | 效果 |
|---|---|---|
| 切换展品 | 单击画面 / 摄像头**捏合** | 下一件展品，1 秒交叉淡切 |
| 旋转观瞧 | 鼠标拖拽 / 手掌移动 | 藏品跟随旋转，带惯性 |
| 缩放 | 滚轮 / 触屏双指 / **双手拉距** | 0.45–2.55 倍视野缩放 |
| 爆散星尘 | 摄像头**握拳** | 傩面爆散为星尘云雾，松手回聚 |
| 编辑展签 | 双击画面文字 | 就地修改，失焦保存 |
| 语音讲解 | 底部麦克风按钮 | 说出问题，播放对应科普讲解 |

无手干预时藏品以默认速度缓慢自转。完整手势参数、状态机与设置面板说明见 **[docs/交互说明.md](docs/交互说明.md)**。

## Quick Start · 快速开始

环境要求：Node.js ≥ 18（CI 与推荐环境为 20），现代浏览器（Chrome / Edge 最佳）。

```bash
git clone https://github.com/KINGKAZMAX/nuo-culture-digital-museum.git
cd nuo-culture-digital-museum

npm install
npm run dev       # 开发服务器 http://localhost:5188（--host 已开启，局域网可访问）
npm run build     # 构建产物输出至 dist/
npm run preview   # 本地预览构建产物（同 5188 端口）
```

说明：

- 首次进入自动加载模型与手势引擎；摄像头为可选项，可在设置面板中开启
- 全部资源离线自托管（点云、手势模型、中文字体、语音、音乐），运行期不请求外网

## Tech Stack · 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 构建 | **Vite 5** | `base: './'` 相对路径，兼容任意子路径静态部署 |
| 渲染 | **Three.js 0.170** | 场景 / 相机 / UnrealBloom 泛光 / 1 秒交叉淡切转场 |
| 着色 | **原生 GLSL ShaderMaterial** | 自定义点云着色器：噪声爆散、星尘闪烁、点尺寸透视衰减 |
| 手势 | **MediaPipe Tasks Vision 0.10** | GestureRecognizer：21 点骨架 × 2 手，wasm 本地推理（GPU delegate） |
| 语音 | **Web Speech API + 预生成离线语音** | 麦克风识别（zh-CN）+ Piper 预合成讲解音频 |
| 音频 | **HTMLAudioElement** | 背景音乐循环播放，音量 / 开关持久化 |
| 数据 | **自研 TDPC 点云格式** | f32 全精度位置 + 颜色，gzip 传输，浏览器端解压 |
| 存储 | **IndexedDB / localStorage** | 用户上传展品 / UI 配置，刷新不丢 |
| 字体 | **@fontsource × 6** | 刘建军毛草、志莽行书、龙藏行书、马善政毛笔楷、站酷小薇、思源宋体，unicode-range 子集本地化 |

## Project Structure · 目录结构

```
nuo-culture-digital-museum/
├─ index.html              # 单页入口：舞台 + 展签层 + 顶栏/底栏 + HUD + 设置面板
├─ src/
│  ├─ main.js              # 启动编排、视图控制、配置持久化、模型上传
│  ├─ scene.js             # Three.js 舞台：相机、泛光、转场、背景星云
│  ├─ pointCloud.js        # 点云解压解析（TDPC/BPC1）+ 粒子着色器
│  ├─ handControl.js       # MediaPipe 手势 → 交互状态映射
│  ├─ modelConvert.js      # 浏览器端 PLY/GLB/OBJ → 点云
│  ├─ modelStore.js        # 内置 + 用户展品注册表（IndexedDB）
│  ├─ idb.js               # IndexedDB 轻封装
│  ├─ style.css            # 黑白灰数字馆 UI
│  └─ voice/               # 语音科普模块（知识库 kb.json + 状态机 voice.js）
├─ tools/                  # Node 端资产管线脚本
├─ public/
│  ├─ models/              # 五面傩面 + 双层背景点云（.tdp.gz）+ manifest.json
│  ├─ audio/               # 背景音乐 + 17 段科普讲解语音
│  ├─ mediapipe/           # wasm 运行时 + 手势模型（离线自托管）
│  ├─ fonts/               # 6 款离线中文字体
│  └─ assets/              # 静态图片
├─ docs/                   # 项目文档（交互说明 / 性能与资产 / 截图）
└─ .github/workflows/      # GitHub Pages 自动部署
```

## Deployment · 部署

已配置 GitHub Actions 自动部署（`.github/workflows/deploy.yml`）：

1. push 到 `main` 分支（或手动触发 `workflow_dispatch`）
2. Actions 执行 `npm ci` + `npm run build`，将 `dist/` 发布至 GitHub Pages
3. 在线地址：<https://kingkazmax.github.io/nuo-culture-digital-museum/>

前置设置：仓库 Settings → Pages → Source 选择 **GitHub Actions**（仅需一次）。Vite 已配置 `base: './'` 相对路径，天然兼容 Pages 子路径；`dist/` 亦可直接部署到任意静态托管（Nginx / OSS / Vercel 等）。

## Screenshots · 截图

> 以下为截图占位，图片存放于 `docs/screenshots/`。

| 展馆全景 | 手势交互 | 星尘爆散 |
|:---:|:---:|:---:|
| ![展馆全景](docs/screenshots/overview.png) | ![手势交互](docs/screenshots/gesture.png) | ![星尘爆散](docs/screenshots/dispersion.png) |

| 语音科普 | 设置面板 | 展签编辑 |
|:---:|:---:|:---:|
| ![语音科普](docs/screenshots/voice.png) | ![设置面板](docs/screenshots/panel.png) | ![展签编辑](docs/screenshots/edit.png) |

## Documentation · 更多文档

- [docs/交互说明.md](docs/交互说明.md) —— 完整交互文档：鼠标 / 触屏 / 手势三类输入的参数细节、语音问答状态机、设置面板逐项说明
- [docs/性能与资产.md](docs/性能与资产.md) —— TDPC 点云资产格式、加载与缓存策略、manifest 字段、用户模型持久化与性能预算

## About Nuo · 关于傩

傩是上古驱疫纳吉之仪式，傩戏被誉为「中国戏剧活化石」。黔地德江傩堂戏、安顺地戏、威宁撮泰吉均为国家级非物质文化遗产。傩面「以色喻德」：红表忠勇、黑表刚直、金表神异。本馆以数字点云为刻刀，让更多人隔屏照面千年傩韵。

## Event · 赛事

多彩贵州·贵客松 AI 应用场景共创赛（2026 数博会配套活动）参赛作品。GitHub 仓库 Tag：[`Guikesong`](https://github.com/KINGKAZMAX/nuo-culture-digital-museum/releases/tag/Guikesong)

## License · 许可

MIT
