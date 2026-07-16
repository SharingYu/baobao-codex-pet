# 空壳运行器与内容包架构

`Pet Desktop Companion` 是不附带角色内容的 Windows 运行器。它负责透明桌面、窗口平台、输入穿透、养成、存档、托盘和安全安装；宠物与道具永远通过独立内容包进入用户数据目录。

```text
Windows 安装器 / 便携版
  └─ Electron runtime
       ├─ userData/petpacks/<pet-id>/       ← .petpack 原子导入
       ├─ userData/itempacks/<itempack-id>/ ← .itempack 原子导入
       └─ userData/desktop-state.json       ← 选择、位置、亲密度、开关与引导状态
```

仓库中的 `petpacks/`、`itempacks/` 是制作与验证样例，不会由 electron-builder 复制到最终运行器。

## 内容包职责

| 层 | 格式 | 可售卖内容 | 运行时权限 |
| --- | --- | --- | --- |
| 运行器 | Windows 安装器/便携版 | 透明桌面、窗口平台、互动与养成 | 只读窗口几何，不读内容 |
| 宠物 | `.petpack` | 外形、动作图集、触摸区域、互动映射 | 仅声明式 JSON + PNG/WebP |
| 道具 | `.itempack` | 食物、弹球、逗玩、藏身处素材与解锁等级 | 仅声明式 JSON + PNG/WebP |

道具包的 `behavior` 是白名单：`treat`、`ball`、`wand`、`hideout`。无论包来自谁，都不能携带 JavaScript、HTML、SVG、可执行文件或命令。

## 安全边界

- Renderer 开启 `contextIsolation` 与 sandbox，关闭 Node 集成。
- Preload 只暴露白名单 IPC，不提供任意文件路径或命令执行。
- 资源经只读 `petpack://pets/...` 或 `petpack://items/...` 加载；每次请求都做 realpath 边界检查。
- 两种包会校验相对路径、ZIP 结构、符号链接、文件数量/体积、图片尺寸、SHA-256 和声明完整性。
- 导入先写入随机临时目录，完成后原子改名；同 ID 不会静默覆盖。
- 状态文件限制为 2 MB，并采用临时文件 + 备份的原子写入；未知历史字段会保留。

## 窗口平台适配器

主进程只在用户开启窗口平台互动后启动本地 watcher，约每 120ms 获取可用顶层窗口的几何；关闭开关会立即结束 watcher、清空缓存并取消重启。原生端只生成 `hwnd/pid/left/top/right/bottom`，主进程做字节上限、JSON 校验、DPI 映射、字段白名单和 overlay 局部坐标转换；渲染器据此做吸附、行走、跟随和下落。

watcher 不获取标题、截图、OCR、DOM、控件或键盘输入。启动失败、输出无效或停滞时会指数退避重启，渲染器继续使用桌面地面，不让系统适配器拖死 UI。详见 [window-edge-scenes.md](window-edge-scenes.md)。

## 渲染器状态与优先级

状态 v2 按宠物保存可见性、当前位置和亲密度；临时食物、玩具、手掌模式与窗口附件不跨进程残留。

```text
退出/隐藏 > 安静模式 > 用户拖动 > 分部位摸摸/投喂/玩具 > 窗口平台 > 自主活动 > 待机
```

覆盖窗口默认点击穿透。Renderer 上报宠物、道具、浮条、弹窗和引导卡的矩形区域；主进程只在光标进入这些区域时暂时关闭穿透，避免挡住下方应用。

## 运行与构建

```powershell
pnpm install
pnpm check
pnpm build
pnpm dist:win
pnpm dist:portable
```

两种构建都只生成空壳运行器，并把验证/导入库与窗口 watcher 置入应用资源目录。公开测试版尚未使用商业代码签名证书，Windows 可能显示 SmartScreen；正式销售前必须使用受信任证书签名。
