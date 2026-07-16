# 可售卖定制宠物交付闭环

交付分成三件互不绑定的商品：空壳运行器、`.petpack` 宠物包、`.itempack` 道具包。包包和菲菲用于验证宠物制作闭环；起步道具盒用于验证互动素材闭环。客户可以只购买宠物，也可以后续加购主题道具。

## 1. 客户素材与角色包

建议收集 5–10 张清晰照片和 1–3 段短视频：正脸、左右侧脸、全身、尾巴、典型花纹、常戴饰品，以及走路、回头、趴下、扑玩具等动作。

原始素材只进入私有制作目录。公开仓库和最终 `.petpack` 只包含重绘后的透明动画资源及 manifest，不包含照片、视频、EXIF 或社交平台水印。

动作基线：待机、左右移动、摸摸后的开心、零食靠近与接受、追球/扑逗玩、等待与 16 个注视方向。

```powershell
node tools/petpack/convert-codex.mjs --input pets/baobao --output petpacks/baobao
node tools/petpack/cli.mjs validate petpacks/baobao
node tools/petpack/cli.mjs pack petpacks/baobao release/petpacks/baobao.petpack
```

Alpha 的宠物图集仍要求 Codex v2 的 `192 × 208` 单格、`8 × 11` 布局和 16 个注视方向；不兼容布局会明确拒绝，不会悄悄显示错帧。

## 2. 道具包

道具包是独立素材商品，可按节日、房间主题、食物偏好或联名单独销售。每件道具必须指定受限行为：

- `treat`：投放后最近宠物靠近、嗅闻并接受。
- `ball`：带重力与弹跳，宠物追逐、扑击。
- `wand`：跟随指针，宠物短距离扑玩。
- `hideout`：可进入的纸箱/小屋类藏身处。

```powershell
node tools/itempack/cli.mjs validate itempacks/starter-play-kit
node tools/itempack/cli.mjs pack itempacks/starter-play-kit release/itempacks/starter-play-kit.itempack
node tools/itempack/cli.mjs validate release/itempacks/starter-play-kit.itempack
```

运行器只解释白名单行为；道具包不能自带脚本、HTML、SVG、二进制程序或任意网络逻辑。

## 3. 客户安装与验收

1. 安装并启动 **Pet Desktop Companion**；此时程序是空壳，会提示导入内容包。
2. 导入客户的 `.petpack`，宠物立即进入桌面。
3. 导入已购买的 `.itempack`，底部“投喂”和“玩具”会显示包内道具。
4. 完成摸摸、拖动、投喂、玩具和“边缘”跑跳各一次。
5. 打开安静模式，从底部内容包管理区选择“退出程序”或右键托盘选择“退出”；再重启，确认位置与安静状态恢复。

包 ID 不会静默覆盖。升级包应使用新的版本化交付流程；当前 Alpha 在同 ID 已安装时要求用户先显式移除旧包。

## 4. 首轮验收

- [ ] 空壳安装器内不包含包包、菲菲或任何道具资源。
- [ ] 包包、菲菲 `.petpack` 可分别验证、打包、导入并显示。
- [ ] 起步 `.itempack` 可验证、打包、导入，且三类互动道具使用外部图片。
- [ ] 宠物可拖动、摸摸、安静、恢复位置。
- [ ] 屏幕工作区边缘场景可跑动并跳下。
- [ ] 空白区域持续点击穿透，托盘可显示、隐藏、退出。
- [ ] 导入器拒绝路径穿越、符号链接、可执行内容、哈希不匹配和未声明文件。

## 5. 售后与隐私

每单保留交付清单、manifest 哈希和制作版本；不长期保留原始照片。客户确认交付或退款后 24 小时内删除活动存储中的源素材，备份最迟 30 天清除。返工只替换相应宠物包或道具包，不要求客户重装运行器，也不应清除已有桌面位置与互动存档。
