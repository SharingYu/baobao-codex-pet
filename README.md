# Pet Desktop Companion · 可售卖的空壳运行器

把真实宠物带进电脑，但不把任何角色内容绑进安装包。Windows 用户先安装运行器，再分别导入宠物包和道具包；三者可以独立定制、升级、交付与售卖，无需 Codex。

> `v0.2.0-alpha` 起，安装器本身不再内置包包、菲菲或任何食物/玩具。

[下载 Windows v0.2 Alpha](https://github.com/SharingYu/baobao-codex-pet/releases/tag/v0.2.0-alpha) · [Windows 使用指南](docs/user-guide.md) · [定制交付流程](docs/customization-workflow.md) · [产品 PRD](docs/universal-desktop-pet-prd.md)

![导入包包和菲菲后的桌面效果](docs/assets/desktop-alpha.png)

<p align="center">导入示例宠物包后的桌面效果；安装器首次启动仍是空壳。</p>

## 三层交付

```text
Pet Desktop Companion（免费/基础运行器）
  ├─ .petpack   一只真实宠物的动作图集与行为映射
  └─ .itempack  食物、玩具、藏身处等互动素材与受限行为
```

- 运行器只负责透明桌面、点击穿透、物理互动、存档、托盘与安全导入。
- 宠物包只包含声明式 manifest 和透明 PNG/WebP 动画图集。
- 道具包只包含声明式 manifest 和 PNG/WebP 素材；行为限定为零食、弹球、逗玩与藏身处，包内不能执行脚本。
- 用户可购买一只宠物、一个主题道具包，或单独替换任一内容包，而不必重装程序。

## Alpha 已实现

- 空壳启动页：未装宠物时不会显示默认角色。
- 独立导入 `.petpack` 与 `.itempack`，文件落在用户数据目录，不改安装目录。
- 宠物：摸摸、拖动、安静陪伴、本地位置恢复。
- 道具：从已安装道具包动态读取食物、小球、逗玩道具、藏身处及对应图片。
- 场景：宠物会在屏幕工作区边缘跑动，并从边缘跳下；底部“边缘”按钮可立即触发。
- 透明区域点击穿透；托盘可显示、隐藏、安静或退出。

## 下载、安装与首次打开

1. 从 GitHub Release `v0.2.0-alpha` 下载 `PetDesktop-0.2.0-alpha-x64.exe`、两个示例 `.petpack`、`starter-play-kit.itempack` 和校验和文件。
2. 运行安装器，可按提示选择目录。安装完成后，从桌面快捷方式或 Windows“开始”菜单打开 **Pet Desktop Companion**。
3. 首次启动是正常的空壳状态。点击“导入宠物包”，选择 `baobao.petpack`；再从底部最右侧的内容包管理按钮导入 `feifei.petpack`。
4. 在同一管理区点击“导入道具包”，选择 `starter-play-kit.itempack`。随后“投喂”和“玩具”会显示包内道具。

公开 Alpha 暂未使用商业代码签名证书，Windows 可能显示 SmartScreen。请只从本仓库 Release 下载，并先核对 SHA-256：

```powershell
Get-FileHash .\PetDesktop-0.2.0-alpha-x64.exe -Algorithm SHA256
```

确认结果与 `SHA256SUMS-v0.2.0-alpha.txt` 一致后，可选择“更多信息”→“仍要运行”。完整操作见 [Windows 使用指南](docs/user-guide.md)。

## 互动与正确退出

- 点击宠物或“摸摸”会互动；按住宠物可拖动位置。
- “投喂”选择零食；“玩具”选择毛线球、逗玩道具或小屋。
- “边缘”让宠物沿屏幕工作区边缘跑动并跳跃；“安静”暂停主动陪伴。
- 单击系统托盘图标显示或隐藏宠物；右键可显示互动条、切换安静模式或退出。
- 隐藏不等于退出。请使用底部内容包管理区的“退出程序”，或右键托盘图标选择“退出”。

包包、菲菲和起步道具均是独立示例内容，不会随运行器安装。

## 打包与交付

### 宠物包

```powershell
node tools/petpack/convert-codex.mjs --input pets/my-cat --output petpacks/my-cat
node tools/petpack/cli.mjs validate petpacks/my-cat
node tools/petpack/cli.mjs pack petpacks/my-cat release/petpacks/my-cat.petpack
```

### 道具包

```powershell
node tools/itempack/cli.mjs validate itempacks/starter-play-kit
node tools/itempack/cli.mjs pack itempacks/starter-play-kit release/itempacks/starter-play-kit.itempack
```

两种导入器都会拒绝路径穿越、符号链接、Windows 保留路径、主动/可执行内容、超大文件、哈希不匹配和未声明资源。

## 边框与页面互动的边界

当前版本已经使用**屏幕工作区边缘**作为可见场景：跑到边缘、跳下、落回桌面，不读取其他程序内容。

下一层可以做“前台窗口边框轨道”：在用户明确开启后，仅读取当前窗口的几何矩形，让宠物沿标题栏、窗口边缘和任务栏跑跳。网页正文、聊天内容、文档文字不需要也不会被读取。若未来要做“看到页面里的鱼、光标或视频再反应”，必须做成单独的、按应用授权的辅助功能，并在本地处理与可随时关闭；不能默认扫描屏幕内容。

详细方案见 [窗口边缘场景与隐私边界](docs/window-edge-scenes.md) 与 [定制交付流程](docs/customization-workflow.md)。

## 本地开发

需要 Node.js 22.12+ 与 pnpm 11.7+：

```powershell
pnpm install
pnpm check
pnpm dev
pnpm dist:win
```

```text
apps/desktop/electron   透明窗口、托盘、点击穿透、独立包导入与原子存档
apps/desktop/renderer   Canvas 动画、包驱动的互动与边缘场景
packages/pet-schema    .petpack v1 Schema 与类型
packages/item-schema   .itempack v1 Schema 与类型
tools/petpack          宠物转换、验证、打包和导入工具
tools/itempack         道具验证、打包和导入工具
petpacks               包包、菲菲独立宠物包示例
itempacks              独立道具包示例
```

## 隐私与授权

客户原始照片、视频、EXIF 和社交平台水印只应存在于私有制作目录，不能提交到公开仓库。交付包只含重绘的动画或道具资源与声明式配置。

代码、Schema、工具和起步道具包采用 [MIT License](LICENSE)。包包、菲菲的角色形象和动画资产采用单独的 [`LicenseRef-Personal-Display-Only`](LICENSES/LicenseRef-Personal-Display-Only.txt)，具体边界见 [NOTICE](NOTICE.md)。
