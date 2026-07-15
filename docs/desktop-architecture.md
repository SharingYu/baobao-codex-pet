# 宠物桌伴 Alpha 架构

首轮为了在当前 Windows 环境完成可安装闭环，使用 Electron 壳 + 原生 Canvas 运行时。渲染、状态机和 `.petpack` 均保持平台无关，后续可以把壳替换为 Tauri，而无需重做宠物内容。

```text
apps/desktop/electron   透明窗口、托盘、点击穿透、导入和本地存档
apps/desktop/renderer   Canvas 动画、投喂、玩具、摸摸和安静模式
packages/pet-schema    声明式 .petpack v1 JSON Schema 与类型
tools/petpack          转换、验证、打包和导入工具
petpacks               包包、菲菲通用宠物包
pets                   Codex v2 原始交付包
```

## 安全边界

- Renderer 开启 `contextIsolation` 与 sandbox，关闭 Node 集成。
- Preload 只暴露白名单 IPC，不提供任意文件路径或命令执行。
- 宠物资产通过只读 `petpack://` 协议加载，路径必须位于内置或用户宠物目录内。
- `.petpack` 只允许声明式数据和白名单图片，不执行包内脚本。
- 状态文件限制为 2 MB，并采用临时文件 + 备份的原子写入方式。
- 导入的宠物存放在 Electron `userData/petpacks`，不会修改安装目录。

## 首版状态优先级

```text
退出/隐藏 > 安静模式 > 用户拖动 > 摸摸/投喂/玩具 > 自主活动 > 待机
```

覆盖窗口默认点击穿透。Renderer 定期上报猫、玩具和操作条的矩形区域；主进程只在光标进入这些区域时暂时关闭穿透，避免挡住下方应用。

## 运行与构建

```powershell
pnpm install
pnpm dev
pnpm check
pnpm dist:win
```

`pnpm dist:win` 生成 Windows NSIS 安装程序。公开测试版未做商业代码签名，Windows 可能显示 SmartScreen 提示；正式销售前必须使用受信任证书签名。
