# Electron Windows 桌面壳

这个目录只负责操作系统能力：透明桌面层、系统托盘、点击穿透、受限 IPC、宠物包读取和原子状态存档。宠物动画与控制台 UI 均由 `apps/desktop/renderer` 提供，renderer 不需要也不能直接访问 Node.js。

## 窗口行为

- overlay 是覆盖主显示器工作区的透明、无边框、始终置顶窗口。
- overlay 设置为 `focusable: false`，启动与重新显示均使用 `showInactive()`；在 Windows 下不会抢走当前应用焦点。
- 不在任务栏显示，不允许移动、缩放、最小化或最大化。
- control 是普通控制台窗口，只有用户从托盘选择“打开控制台”时才显示并取得焦点。
- 关闭任一窗口不会退出应用；应用生命周期由系统托盘持有。

托盘菜单包含“显示/隐藏宠物”“安静模式”“打开控制台”和“退出”。单击托盘图标切换宠物显示，双击打开控制台。

renderer 通过查询参数区分入口：

```js
const view = new URLSearchParams(location.search).get("petView");
// "overlay" | "control"
```

如果构建目录包含 `overlay.html` 或 `control.html`，主进程优先使用对应文件；否则两个窗口都加载 `index.html` 并依赖上面的参数分流。

## Renderer API

preload 只暴露 `window.petDesktop`，不会暴露 `ipcRenderer`、文件系统或 shell。

```ts
type Rect = { x: number; y: number; width: number; height: number };

type ShellState = {
  visible: boolean;
  quiet: boolean;
  displayId: string | number | null;
};

type PetCatalog = {
  schemaVersion: 1;
  rootKind: "development" | "packaged" | "override";
  roots: { builtin: string; user: "userData" };
  pets: Array<{
    id: string;
    name: string;
    manifest: Record<string, unknown>;
    manifestFile: "manifest.json" | "pet.json" | "pack.json";
    installation: "builtin" | "user";
    removable: boolean;
    assetBaseUrl: string;
  }>;
};

interface PetDesktopApi {
  loadPetCatalog(): Promise<PetCatalog>;
  importPetpack(): Promise<
    | { ok: false; cancelled: true }
    | { ok: true; cancelled: false; petId: string; manifest: object; catalog: PetCatalog }
  >;
  removePetpack(id: string): Promise<{
    ok: true;
    removed: boolean;
    petId: string;
    catalog: PetCatalog;
  }>;
  loadState<T = unknown>(): Promise<T>;
  saveState<T = unknown>(state: T): Promise<T>;

  setInteractiveRegions(regions: Rect[]): Promise<Rect[]>;
  setPointerHover(hovered: boolean): Promise<boolean>;
  setIgnoreMouseEvents(
    ignore: boolean,
    options?: { forward?: boolean },
  ): Promise<{ ignore: boolean; forward: boolean }>;

  getShellState(): Promise<ShellState>;
  setShellState(patch: Partial<Pick<ShellState, "visible" | "quiet">>): Promise<ShellState>;

  onPetCatalogChanged(
    listener: (event: { revision: number; catalog: PetCatalog }) => void,
  ): () => void;
  onShellStateChanged(listener: (state: ShellState) => void): () => void;
}
```

`loadState` / `saveState` 只读写 renderer 快照，不包含系统壳的显示和安静状态。`saveState` 是全量替换，值必须可 JSON 序列化，最大 2 MiB。两个 `on...` 方法都返回取消订阅函数。

### 选择性点击穿透

推荐由 overlay 在布局变化时上报可点击区域。坐标使用窗口内 CSS 像素（与 Electron 的 DIP 坐标一致）：

```js
function publishHitRegions() {
  const regions = [...document.querySelectorAll("[data-pet-interactive]")].map((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  return window.petDesktop.setInteractiveRegions(regions);
}

addEventListener("resize", publishHitRegions);
new ResizeObserver(publishHitRegions).observe(document.body);
```

主进程定时读取系统光标位置：进入任一上报区域时接收点击，离开时调用 `setIgnoreMouseEvents(true, { forward: true })` 将点击交还给下层窗口。空区域列表会退回 hover 模式，此时 renderer 可调用：

```js
petElement.addEventListener("pointerenter", () =>
  window.petDesktop.setPointerHover(true),
);
petElement.addEventListener("pointerleave", () =>
  window.petDesktop.setPointerHover(false),
);
```

`setIgnoreMouseEvents` 是显式手动模式。下一次 `setInteractiveRegions` 或 `setPointerHover` 会恢复自动区域/hover 模式。鼠标相关三个方法只允许 overlay renderer 调用；control 调用会被主进程拒绝。

## 宠物包目录与资源 URL

默认目录：

- 内置开发包：仓库根目录的 `petpacks/`
- 内置打包资源：`process.resourcesPath/petpacks/`
- 用户导入包：Electron `userData/petpacks/`

每个一级子目录是一只宠物，必须有 `manifest.json`、`pet.json` 或 `pack.json` 之一。catalog 原样返回 manifest，并提供安全的资源根 URL。例如目录 `petpacks/baobao/` 对应：

```js
const catalog = await window.petDesktop.loadPetCatalog();
const baobao = catalog.pets.find((pet) => pet.id === "baobao");
const atlas = baobao.manifest.assets.find(
  (asset) => asset.id === baobao.manifest.renderer.atlasAsset,
);
const spriteUrl = new URL(atlas.path, baobao.assetBaseUrl).toString();
// petpack://builtin/baobao/assets/atlas.webp
```

内置资源使用 `petpack://builtin/...`，用户导入资源使用 `petpack://user/...`。handler 会做 realpath 边界检查，拒绝 `..`、编码斜杠和逃逸到对应 petpacks 根目录以外的符号链接。目录变化会通过 `onPetCatalogChanged` 推送完整新 catalog。

`importPetpack()` 打开系统文件选择框，只接受 `.petpack`。主进程先调用可信 petpack runtime 完整校验，再检查 Alpha 运行器是否支持其 Codex v2 图集布局，最后原子导入 `userData/petpacks/<manifest.id>/`；不会覆盖已有包，也不允许用户包冒用内置 id。`removePetpack(id)` 只会删除该用户目录，内置包永远不可删除。取消文件框不是异常，返回 `{ ok: false, cancelled: true }`；校验失败通过 rejected Promise 返回带错误码前缀的信息。

petpack runtime 路径：

- 开发：`tools/petpack/lib.mjs`
- 打包：`process.resourcesPath/petpack-runtime/lib.mjs`

打包配置需要将该库复制到上述位置。可用 `PET_DESKTOP_PETPACK_LIBRARY` 或 `--petpack-library=...` 覆盖。

## 状态文件

状态位于 Electron `userData/desktop-state.json`。主进程先写同目录临时文件并 `fsync`，再重命名覆盖；旧版本保存在 `desktop-state.json.bak`，启动读取失败时自动尝试备份。文件结构由主进程维护：

```json
{
  "schemaVersion": 1,
  "shell": { "visible": true, "quiet": false, "displayId": null },
  "rendererState": {}
}
```

## 开发启动与路径覆盖

Vite 开发服务器运行在 `http://localhost:5173` 时：

```powershell
$env:PET_DESKTOP_RENDERER_URL = "http://localhost:5173"
npx electron apps/desktop/electron/main.cjs
```

也可以使用命令行参数。命令行优先于环境变量：

| 作用 | 命令行 | 环境变量 |
| --- | --- | --- |
| 两个窗口共用的开发 URL | `--renderer-url=...` | `PET_DESKTOP_RENDERER_URL`（兼容 `PET_DESKTOP_DEV_URL`） |
| production renderer 目录 | `--renderer-dir=...` | `PET_DESKTOP_RENDERER_DIR` |
| overlay 独立 URL/HTML 路径 | `--overlay-url=...` | `PET_DESKTOP_OVERLAY_URL` |
| control 独立 URL/HTML 路径 | `--control-url=...` | `PET_DESKTOP_CONTROL_URL` |
| 宠物包目录 | `--petpacks-dir=...` | `PET_DESKTOP_PETPACKS_DIR` |
| petpack 校验/导入库 | `--petpack-library=...` | `PET_DESKTOP_PETPACK_LIBRARY` |
| 托盘 PNG/ICO 路径 | `--tray-icon=...` | `PET_DESKTOP_TRAY_ICON` |

未设置 URL 时，开发默认加载仓库的 `apps/desktop/dist/`，打包默认加载 app/asar 内的 `apps/desktop/dist/`。如果打包布局不同，可通过 `PET_DESKTOP_RENDERER_DIR` 指定 production 目录。根 `package.json` 已配置 electron-builder，把内置宠物复制到 `process.resourcesPath/petpacks/`，并把导入库复制到 `process.resourcesPath/petpack-runtime/lib.mjs`。

## 安全边界

- 所有窗口均启用 `contextIsolation`、sandbox，并关闭 `nodeIntegration`。
- production 禁用 DevTools。
- IPC 校验发送方，只接受本进程创建的 overlay/control WebContents。
- 新窗口一律拒绝；顶层导航只允许本地页面或配置的开发服务器同源地址。
- preload 只暴露上文列出的命名方法。
