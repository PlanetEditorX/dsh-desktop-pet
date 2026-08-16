# dsh-desktop-pet

DeepSeek Harness（dsh web）的桌面宠物插件：经典深海鲸鱼娘常驻右下角。

- **任务气泡**：会话开始处理 / 回复时弹出动漫气泡显示当前任务（标题、模型、+tokens），悬停气泡可查看本日 Tokens、调用次数、饱腹度、进度与天气详情
- **饱腹状态机**：token 消耗 / 拖入回收的文件会"喂"宠物，饱腹度随时间衰减——饿了会耷拉、长时间不喂会饿趴下（姿态立绘切换），喂食后恢复
- **拖文件回收**：把文件 / 文件夹从资源管理器拖到宠物身上，她张开嘴"吃掉"——host 端移入系统回收站（Electron `shell.trashItem`，回退 PowerShell RecycleBin）
- **天气配饰**：Open-Meteo 免费接口（无需 key），按城市显示天气配饰（太阳 / 白云 / 粉色小伞雨天 / 红围巾雪天 / 闪电雷暴），宠物会"打伞"
- **多姿态立绘**：站立 / 展示 / 惊讶 / 挥手 / 害羞 / 指责六张全身 PNG 立绘（1024×1536），按事件与饱腹状态切换，全部姿态后台预取零闪烁
- **独立悬浮窗**（桌面版 Electron 专属）：透明置顶小窗显示宠物，可拖动位置，同样支持拖文件回收
- **设置页**：设置 → 桌面宠物，全部参数可调（饱腹阈值 / 衰减速度 / 气泡时长 / 天气城市等）；按住宠物可拖动位置（自动保存）

数据全部保存在本地：

```
~/.dsh/desktop-pet/config.json    # 插件配置（饱腹参数 / 气泡 / 天气城市）
~/.dsh/desktop-pet/state.json     # 状态（今日用量 / 饱腹度 / 天气缓存 / 宠物位置）
```

## 安装

```bash
dsh plugin --profile web add <本仓库路径或已发布的包名>
```

安装后需要**重启 DeepSeek Harness**（托盘退出后重新打开）使插件行生效。重启后：

1. 打开 Web GUI，右下角出现鲸鱼娘
2. 设置 → **桌面宠物** 可调整参数（默认配置开箱即用）

卸载：

```bash
dsh plugin --profile web remove dsh-desktop-pet
```

## 开发

```bash
npm run check              # 语法检查
node scripts/test-host.mjs # host 逻辑端到端测试
```

仓库结构：

```
lib/index.js    host 半区：事件折叠（任务/用量）、饱腹状态机、回收站、天气、RPC 通道、Electron 悬浮窗
lib/client.js   client 半区：右下角浮层宠物（姿态切换、气泡、拖放回收）、设置页 UI
assets/         六张姿态立绘 PNG（left / whale-maid-show / surprised / wave / shy / scold）
cordis.patch.yml  bundle 挂载补丁
scripts/        host 逻辑测试 + bundle 开关
```

改 `lib/client.js` 后**无需重启 Harness**：发布版内置 HMR 轮询（500ms），文件变化自动推送浏览器重载，刷新页面即可生效。

## 隐私与安全

- 天气查询只发 GET 到 Open-Meteo 官方接口（geocoding-api.open-meteo.com / api.open-meteo.com），无 API key
- 拖文件回收只对**你主动拖入**的路径执行 `shell.trashItem`（回收站，不物理删除），并校验绝对路径与存在性
- RPC 通道 `/desktop-pet` 使用 `loopback` 信任策略，非回环来源被连接层拒绝

## License

MIT
