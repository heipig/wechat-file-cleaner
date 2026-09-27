# 微信收发文件清理器

[English](README.en.md) | **简体中文**

一个 Windows 桌面小工具，用来清理微信 PC 版收发的文件：判断每个文件是**你发出去的**还是**收进来的**，查一查硬盘别处还有没有副本，然后批量删掉。

> 现状：能用，但需求来自一台具体机器的实际情况。动手前请先看[运行要求](#运行要求)。

## 下载

到 [Releases 页面](https://github.com/heipig/wechat-file-cleaner/releases/latest) 下载 `微信收发文件清理器-portable.zip`，解压到任意位置，双击运行 `微信收发文件清理器.exe`。

绿色免安装：Electron、Node 运行时、MFT 读取助手全部打在里面，目标电脑不需要装 Node.js、.NET 或 Python。全盘索引需要管理员权限，原因见下文。

仓库里只放源码。构建产物解压后约 319 MB，提交进仓库会让每次 clone 都变得很痛苦，所以放在 Releases。

---

## 它解决什么问题

微信 PC 版把收发文件按月存放。存在哪儿取决于你装的是哪一代微信：

| 微信版本 | 默认根目录 |
|---|---|
| **4.x**（新版，`xwechat_files`） | `C:\Users\<用户名>\Documents\xwechat_files\` |
| **3.x**（旧版，`WeChat Files`） | `C:\Users\<用户名>\Documents\WeChat Files\` |

根目录下面，再按账号、按月份分开存放：

```
微信 4.x：
C:\Users\<用户名>\Documents\xwechat_files\<wxid>_<随机后缀>\
    msg\file\<年-月>\      收发的文档、压缩包、安装包……
    msg\video\<年-月>\     视频
    msg\attach\<哈希>\     图片、语音（按内容哈希分块）

微信 3.x：
C:\Users\<用户名>\Documents\WeChat Files\<wxid>\
    FileStorage\File\<年-月>\
    FileStorage\Video\<年-月>\
    FileStorage\Image\<年-月>\
```

存储位置可以在微信里改到别的盘（3.x 在「设置 → 文件管理」；4.x 也能改，但 4.0.1.17 之前的 4.0.0 不支持）。所以本工具不猜路径，而是让你**自己选文件夹** —— 选到 `msg\file`（3.x 是 `FileStorage\File`）这一层就行，底下的 `<年-月>` 月份文件夹程序会自己认。

手工清理有两个痛点：

1. **分不清哪些还能删。** 你**发出去**的文件，自己电脑上别处通常还有一份（原件本来就来自你）；你**收进来**的文件则不一定另存过 —— 就算存过，也早忘了存哪了。
2. **Windows 自带搜索太慢**，在几 TB 的硬盘上核对"这四千个文件我有没有别的副本"根本不现实。

这个工具几秒钟就能给出答案。

## 判定依据

**发送还是接收 —— 看时间戳。** 月份文件夹的名字是微信处理这条消息的时间，而文件本身保留着当时的修改时间。

- 收到的文件：微信当时写盘，修改时间就落在那个月里。
- 发出的文件：文件本来就在你机器上，修改时间通常早于这个月，有时早好几年。

所以"修改时间明显早于所在月份文件夹"的文件，基本可以认定是发出去的。

这只是个经验判断，工具也确实把它当经验判断用 —— 它旁边永远并排显示**另一个独立信号**，而不是单独采信。

**备份 —— 全盘索引。** 工具直接解析 NTFS 主文件表（MFT），在内存里建立所选磁盘上每个文件的索引（文件名、大小、修改时间）。30 万个文件大约两秒，因为读 MFT 完全不需要一层层遍历目录。

筛出的候选还会用**内容哈希**再核对一遍，所以"同名同大小但内容不同"绝不会被误报成备份。

两列信号故意分开显示。最有价值的一行是：**"判定为收到，但别处有备份"** —— 那就是你另存过又忘了的文件。

## 运行要求

| | |
|---|---|
| 系统 | Windows 10 / 11，64 位 |
| 文件系统 | 全盘索引需要 **NTFS**（FAT32 / exFAT 没有 MFT） |
| 权限 | **管理员**，用来打开 `\\.\X:` 读 MFT |
| Node.js | 绿色版已内置，运行不需要另装 |

**没有管理员权限也能用**：程序会自动切到"只索引指定文件夹"模式，你告诉它备份可能存在哪儿就行。配置麻烦一点，但不用提权。

## 从源码构建

```powershell
npm install
npm start                        # 开发模式运行
node tools/build-portable.mjs    # 生成 dist\微信收发文件清理器-win32-x64\
```

构建全程离线：拿 `node_modules` 里已有的 Electron 组装，用 `@electron/asar` 打包。过程中边做边校验，宁可直接失败，也不会吐出一个坏包。

## 代码里值得一提的地方

值得看的不是界面，是那些被迫绕开的坑。

### 1. Electron 自带的 Node 读不了原始磁盘

读 NTFS 的 MFT 意味着打开 `\\.\D:` 直接读原始字节。这件事在 Node 22+ 上没问题，但在 Electron 33 内嵌的 Node 20 上**不行**：设备能打开，`fstat` 却报告说它是个目录，于是每次读都失败，报 `EISDIR`。同一份代码在 `node.exe` 24 下顺顺当当读完 232 MB 的 MFT。

所以程序先试进程内直读，失败就把扫描交给一个真正的 `node.exe` 子进程（`tools/mft-helper.mjs`），由它把记录以 JSONL 流式吐回来。这个判断在 `src/core/volume-source.js` 里。

### 2. 子进程读不进 asar 包

Node 读不了 `app.asar` 里面的文件，而 Electron 只补丁了自己的 `fs` 层 —— 被它拉起来的解释器看到的是普通文件系统。所以 MFT 助手、它依赖的模块、以及一个 Node 运行时，全部放在压缩包**外面**的 `resources/helper/` 和 `resources/runtime/`。把一个 `app.asar` 路径交给子进程，只会得到 "cannot find module"。

### 3. 启动器自带提权清单

Windows 只认"用户双击的那个 exe"自己清单里声明的权限等级，而一个绿色版 Electron 应用内部的 exe 没法替外层请求提权。`tools/pe-manifest.mjs` 和 `tools/pe-resources.mjs` 就是一个手写的 PE 资源编辑器：给打包后的 exe 塞进一个带 `requireAdministrator` 的 `RT_MANIFEST`，重建资源节，并把节表头指回去。

代码里记录了两个坑：更新序列（fixup）的步长固定是 512 字节，**不是**卷的扇区大小；以及清单里漏掉 `requestedExecutionLevel` 或 `supportedOS` 会让 Windows 11 以错误码 193 拒绝加载该映像。

### 4. 删除功能刻意不用 PowerShell

最初的实现是调 PowerShell 脚本。这依赖好几件不由你控制的事：目标机器装了 PowerShell、执行策略放行（组策略可以覆盖 `-ExecutionPolicy Bypass`）、杀毒软件不拦、并且带着 `Microsoft.VisualBasic` 程序集来支持回收站 —— 每一条都因机器而异。有一位用户的日志显示：原生确认对话框弹出来了，然后永远不返回，看上去和程序崩溃一模一样。

现在删除走的是：

- **永久删除：** Node 的 `fs.rmSync(..., { force: true })`，顺便清掉微信给每个文件都加上的只读属性。
- **放回收站：** 运行时生成一个 `.vbs`，交给 `cscript.exe` 执行 —— 每个 Windows 都有，且不受执行策略管辖。

确认框画在页面里，而不是用 `dialog.showMessageBox`，原生对话框只作为限时兜底。

### 5. 日志写在跟着程序走的地方

打包后的应用没有控制台，而 `%APPDATA%` 也不是能让用户自己去找的地方。日志同时写到 exe 旁边的 `logs\app.log` 和 userData 目录，界面上可以直接查看和打开所在文件夹。

## 验证

这个项目的测试基建比一般小工具多，因为它的失败模式大多不可见："没找到备份"和"程序消失了"这两种现象，无论背后是索引坏了、助手文件缺失还是对话框卡住，看起来都一样。

```
npm test                             # 98 个单元 / 集成测试
node tools/verify-asar.mjs           # 打出来的包里确实带着那些修复
node tools/verify-packaged.mjs       # 每个运行期路径都能解析
node tools/verify-zip.mjs            # 分发用压缩包能解压能跑
node tools/probe-packaged-flow.mjs   # 端到端驱动打包后的应用
node tools/probe-relocate.mjs        # 换个文件夹仍然能用
node tools/probe-theme.cjs           # 主题切换是真的重绘了
```

`probe-packaged-flow.mjs` 最有意思：打出来的 exe 要求提权，脚本没法直接启动它，于是它复制一份包、只把清单里的提权要求改成不需要，然后通过 DevTools 协议驱动真实界面 —— 在无人值守的情况下点"删除"、回答页面内的确认框。

## 已知限制

- **发送/接收是经验判断。** 当月创建、当月发出的文件会被看成收到的。备份那一列就是用来弥补这一点的。
- **用的是 `$STANDARD_INFORMATION` 时间戳**，不是资源管理器列表视图看到的 `$FILE_NAME` 副本。在健康的系统上两者可能差几个小时。
- **位于 `$ATTRIBUTE_LIST` 扩展记录里的文件**，报出的大小可能来自 `$FILE_NAME` 缓存，而不是无名的 `$DATA` 属性。
- **仅支持 x64。** 内置的 Node 运行时和清单都是 amd64 的。
- **索引在内存里**，每次启动重建（约 2–6 秒）。
- **界面是中文的。** 这个工具本来就是为中文 Windows 用户写的。

## 许可证

[MIT](LICENSE)。

应用内打包了 Electron 和 Node.js 运行时，它们各自带自己的许可证；构建产物的 `dist/` 里包含相关声明文件。
