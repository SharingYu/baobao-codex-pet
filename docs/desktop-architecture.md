# 空壳运行器与内容包架构

`Pet Desktop Companion` 是不附带角色内容的 Windows 运行器。它负责透明桌面、场景、输入穿透、存档、托盘和安全安装；宠物与道具永远通过独立内容包进入用户数据目录。

```text
Windows 安装器
  └─ Electron runtime
       ├─ userData/petpacks/<pet-id>/       ← .petpack 原子导入
       ├─ userData/itempacks/<itempack-id>/ ← .itempack 原子导入
       └─ userData/desktop-state.json       ← 位置、安静状态、引导状态
```

仓库中的 `petpacks/`、`itempacks/` 是制作与验证样例，不会由 electron-builder 复制到最终安装器。

## 内容包职责

| 层 | 格式 | 可售卖内容 | 运行时权限 |
| --- | --- | --- | --- |
| 运行器 | Windows 安装器 | 桌面运行时、场景能力 | 不读取第三方页面内容 |
| 宠物 | `.petpack` | 外形、动作图集、互动映射 | 仅声明式 JSON + PNG/WebP |
| 道具 | `.itempack` | 食物、弹球、逗玩、藏身处素材 | 仅声明式 JSON + PNG/WebP |

道具包的 `behavior` 是白名单：`treat`、`ball`、`wand`、`hideout`。无论包来自谁，都不能携带 JavaScript、HTML、SVG、可执行文件或命令。

## 安全边界

- Renderer 开启 `contextIsolation` 与 sandbox，关闭 Node 集成。
- Preload 只暴露白名单 IPC，不提供任意文件路径或命令执行。
- 资源经只读 `petpack://pets/...` 或 `petpack://items/...` 加载；每次请求都做 realpath 边界检查。
- 两种包会校验相对路径、ZIP 结构、符号链接、文件数量/体积、图片尺寸、SHA-256 和声明完整性。
- 导入先写入随机临时目录，完成后原子改名；同 ID 不会静默覆盖。
- 状态文件限制为 2 MB，并采用临时文件 + 备份的原子写入。

## 场景与前台窗口

首版场景只依赖运行器自身的屏幕工作区坐标：宠物可以沿边缘跑、跳下并着陆。这一层不采集窗口标题、页面图像或任何文本。

下一层“窗口边框轨道”应是一个可选 Windows 适配器：用户显式开启后，适配器只向渲染器提供前台窗口的矩形和最小化/全屏状态，渲染器据此生成可走的标题栏、左右边和底边轨道。不得把截图、OCR、网页 DOM、聊天正文或文档内容送入运行器或网络。详见 [window-edge-scenes.md](window-edge-scenes.md)。

## 状态优先级

```text
退出/隐藏 > 安静模式 > 用户拖动 > 手动互动 > 边缘场景 > 自主活动 > 待机
```

覆盖窗口默认点击穿透。Renderer 定期上报宠物、道具、浮条和引导卡的矩形区域；主进程只在光标进入这些区域时暂时关闭穿透，避免挡住下方应用。

## 运行与构建

```powershell
pnpm install
pnpm check
pnpm build
pnpm dist:win
```

`pnpm dist:win` 只生成空壳安装器，并把两种验证/导入库置入应用资源目录。公开测试版尚未使用商业代码签名证书，Windows 可能显示 SmartScreen 提示；正式销售前必须使用受信任证书签名。
