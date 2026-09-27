# 开发与实现说明

面向想读代码、改代码、自己构建的人。**普通用户请回到 [README.md](README.md)。**

## 目录结构

```
src/main/main.js         Electron 主进程：窗口、IPC、扫描/索引/匹配/删除的调度
src/preload/preload.js   暴露给页面的 cleaner.* 接口
src/renderer/            界面（无框架，原生 DOM + 虚拟滚动表格）
src/core/wechat-scan.js  微信目录扫描、月份识别、收发判定
src/core/volume-source.js 决定用哪种方式读盘（进程内 / 子进程助手）
src/core/delete.js       删除：永久删除与回收站
src/core/logger.js       双位置日志
src/mft/ntfs.js          NTFS 引导扇区与 MFT 记录解析
src/mft/mft-index.js     全盘文件索引、内容哈希、备份匹配
tools/                   构建、验证、界面自动化探针
test/                    node --test 单元与集成测试
```

## 构建

```powershell
npm install
npm start                        # 开发模式运行
node tools/build-portable.mjs    # 生成 dist\微信收发文件清理器-win32-x64\
```

构建全程离线：拿 `node_modules` 里已有的 Electron 组装，用 `@electron/asar` 打包。过程中边做边校验，宁可直接失败，也不会吐出一个坏包。

## 实现上被迫绕开的几个坑

值得看的不是界面，是下面这些。

### 1. Electron 自带的 Node 读不了原始磁盘

读 NTFS 的 MFT 意味着打开 `\\.\D:` 直接读原始字节。这件事在 Node 22+ 上没问题，但在 Electron 33 内嵌的 Node 20 上**不行**：设备能打开，`fstat` 却报告说它是个目录，于是每次读都失败，报 `EISDIR`。同一份代码在 `node.exe` 24 下顺顺当当读完 232 MB 的 MFT。

所以程序先试进程内直读，失败就把扫描交给一个真正的 `node.exe` 子进程（`tools/mft-helper.mjs`），由它把记录以 JSONL 流式吐回来。这个判断在 `src/core/volume-source.js` 里。

### 2. 子进程读不进 asar 包

Node 读不了 `app.asar` 里面的文件，而 Electron 只补丁了自己的 `fs` 层 —— 被它拉起来的解释器看到的是普通文件系统。所以 MFT 助手、它依赖的模块、以及一个 Node 运行时，全部放在压缩包**外面**的 `resources/helper/` 和 `resources/runtime/`。把一个 `app.asar` 路径交给子进程，只会得到 "cannot find module"。

### 3. 启动器自带提权清单

Windows 只认"用户双击的那个 exe"自己清单里声明的权限等级，而一个绿色版 Electron 应用内部的 exe 没法替外层请求提权。`tools/pe-manifest.mjs` 和 `tools/pe-resources.mjs` 就是一个手写的 PE 资源编辑器：给打包后的 exe 塞进一个带 `requireAdministrator` 的 `RT_MANIFEST`，重建资源节，并把节表头指回去。

代码里记录了两个坑：更新序列（fixup）的步长固定是 512 字节，**不是**卷的扇区大小；以及清单里漏掉 `requestedExecutionLevel` 或 `supportedOS` 会让 Windows 11 以错误码 193 拒绝加载该映像。

### 4. 删除功能刻意不用 PowerShell

最初的实现是调 PowerShell 脚本。这依赖好几件不由你控制的事：目标机器装了 PowerShell、执行策略放行（组策略可以覆盖 `-ExecutionPolicy Bypass`）、杀毒软件不拦、并且带着 `Microsoft.VisualBasic` 程序集来支持回收站 —— 每一条都因机器而异。曾经出现过原生确认对话框弹出来却永远不返回、看上去和程序崩溃一模一样的情况。

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
node tools/verify-repo.mjs           # 首次提交会包含哪些文件、有无隐私泄露
node tools/probe-packaged-flow.mjs   # 端到端驱动打包后的应用
node tools/probe-relocate.mjs        # 换个文件夹仍然能用
node tools/probe-theme.cjs           # 主题切换是真的重绘了
```

`probe-packaged-flow.mjs` 最有意思：打出来的 exe 要求提权，脚本没法直接启动它，于是它复制一份包、只把清单里的提权要求改成不需要，然后通过 DevTools 协议驱动真实界面 —— 在无人值守的情况下点「删除」、回答页面内的确认框。

## 技术向的已知限制

- **`$STANDARD_INFORMATION` 时间戳被用作收发判定的依据**，不是资源管理器列表视图看到的 `$FILE_NAME` 副本。在健康的系统上两者可能差几个小时。
- **位于 `$ATTRIBUTE_LIST` 扩展记录里的文件**，报出的大小可能来自 `$FILE_NAME` 缓存，而不是无名的 `$DATA` 属性。
- **索引整体在内存里**，每次启动重建。
- **64 MB 是一道分界线**（`FULL_HASH_LIMIT`）：以下全文哈希，以上改成"精确大小 + 四段均匀采样"，结果会带 `sampled` 标记，调用方可以据此说明它只是抽样。
- **哈希算法在运行时探测**（`pickDigest()`）：Electron 的 Node 没有 `blake2b512`，独立 Node 有，所以算法名会作为前缀写进哈希值，避免不同算法的结果被拿去互相比对。
- **仅支持 x64**：内置的 Node 运行时和 PE 清单都是 amd64 的。

## 许可证

[MIT](LICENSE)。应用内打包了 Electron 和 Node.js 运行时，它们各自带自己的许可证；构建产物的 `dist/` 里包含相关声明文件。
