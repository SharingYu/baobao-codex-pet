# Electron shell

主进程只提供空壳桌宠运行时：透明覆盖层、托盘、点击穿透、原子状态存储、内容包导入与资源协议。它不打包任何宠物或道具。

## 用户数据目录

```text
userData/
  desktop-state.json
  petpacks/<pet-id>/
  itempacks/<itempack-id>/
```

`.petpack` 与 `.itempack` 都先经过各自校验器，再原子解压到对应目录。已存在的 ID 不会被静默覆盖；用户可从界面或后续内容库管理器显式移除。

## 受限 IPC

- `loadPetCatalog`：返回 `{ pets, items }` 的组合目录。
- `importPetpack` / `removePetpack`：只操作 `userData/petpacks`。
- `importItempack` / `removeItempack`：只操作 `userData/itempacks`。
- `loadState` / `saveState`：只读写受限 JSON 快照。
- 覆盖层 IPC：只接收可验证的交互矩形、hover 与 shell 状态。

Renderer 资源通过 `petpack://pets/<id>/...` 与 `petpack://items/<id>/...` 读取。请求会做 URL 段校验、`realpath` 边界检查和普通文件检查，避免目录穿越或符号链接逃逸。

## 托盘

应用不在任务栏常驻。托盘菜单提供显示/隐藏宠物、安静模式、显示互动条和退出。隐藏透明覆盖层不会退出进程；底部内容包管理区的“退出程序”或托盘“退出”才会结束运行器。

## 打包布局

electron-builder 将运行器代码、生产 renderer、宠物包验证库和道具包验证库写入应用资源。样例 `petpacks/`、`itempacks/` 不会复制到安装器，因此首次启动一定是空壳状态。
