# dsh-restart-button

DSH 桌面端标题栏上的一个重启按钮：点一下，整个应用停掉再起来。

> English: one-click restart for the DSH desktop application. The host half
> serves a loopback-only route; a detached Node helper stops the Desktop main
> process and the Host, waits for both to exit, then relaunches and checks that
> the new instance survived startup.

---

## 它解决什么

DSH 的插件配置（`cordis.patch.yml`、bundle 列表、`lib/index.js` 编译常量）有相当一部分
**只在启动时读一次**。改完必须重启才生效。

桌面版没有重启入口：只能关窗口再双击图标。而关窗口在 Windows 上常常只是收进托盘，进程还在，
于是「重启过了但没生效」变成一种稳定复现的错觉。

这个插件把「停干净 + 起回来」做成一个按钮。

---

## 工作原理

```
标题栏按钮
   │  POST /dsh-restart-button/restart
   │  x-dsh-restart-button: 1
   ▼
Host（本插件 index.js）
   │  校验：POST + 标记头 + loopback + 无并发
   │  先回 200，再 setTimeout(100ms)
   ▼
restart-helper.mjs（detached，cwd=%TEMP%）
   │  1. 停 Desktop 主进程（process.ppid）
   │  2. 等它消失（最多 10 s）
   │  3. 停 Host（process.pid）
   │  4. 等它消失（最多 5 s）
   │  5. 用同一可执行文件重新拉起
   │  6. 验证新实例活过了启动期
   ▼
新窗口
```

### 为什么必须先停主进程

主进程持有单实例锁和崩溃恢复对话框。先停 Host 再停主进程，主进程可能弹「Host 意外退出」，
然后抢在 helper 起新实例之前拿到锁。

### 三个 Windows 上的硬约束

1. **`ELECTRON_RUN_AS_NODE` 必须剥离**再拉起应用。Host 本身是主进程用
   `ELECTRON_RUN_AS_NODE=1` 拉起来的，环境变量会继承下去；不剥离的话「新实例」会当成 node
   跑起来，一个窗口都不出现。
2. **不能 spawn 控制台程序**（`cmd.exe`、`timeout`、`tasklist`、`taskkill`）。从一个没有控制台
   的 detached 父进程里拉控制台程序，Windows 会在启动阶段直接杀掉子进程（`0xC0000142`）。
   helper 只用 `process.kill` 和 `existsSync` 判断存活。
3. **`detached: true` 必须配 `windowsHide: true`**。只给 `detached` 的话，子进程照样在启动
   时挂掉。

---

## 装

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:~/Documents/dsh-workspace/link-plugins/dsh-restart-button
```

profile 的 `dsh.profile.bundles` 里加 `dsh-restart-button`。客户端的
`dsh.client` 声明是 `platform: web` + `immediately: true`，所以按钮在标题栏直接出现，
不需要重启就能加载。

## 接口

`POST /dsh-restart-button/restart`

| 条件 | 结果 |
|---|---|
| 方法不是 POST | `405 method not allowed` |
| 缺 `x-dsh-restart-button: 1` | `403 missing x-dsh-restart-button header` |
| 来源不是 127.0.0.1 / ::1 | `403 loopback only` |
| 已有一次重启在排队 | `409 restart already scheduled` |
| 不在桌面应用内 | `200 {ok:false, error:"the restart button only works inside the DSH desktop application"}` |
| 正常 | `200 {ok:true}`，100 ms 后开始重启 |

标记头是 CSRF 防护：跨站表单设不了自定义请求头。

## 日志

`%TEMP%\dsh-restart-button.log`，每行一个 ISO 时间戳加事件：

```
2026-11-03T08:41:02.113Z main 12345 requested=true gone=true
2026-11-03T08:41:02.887Z host 12399 requested=true gone=true
2026-11-03T08:41:04.201Z relaunch attempt 1 pid 15012
```

`--no-launch` 模式只停不起，用来单独验证「能不能停干净」。

## 排错

| 症状 | 原因 |
|---|---|
| 按钮点了没反应 | 端口不是本机访问，或 Host 不在桌面进程里（`process.versions.electron` 为空） |
| 窗口关了但进程还在 | 单实例锁被旧进程占着——查 helper 日志里 `main … gone=false` |
| 重启后没有窗口 | 新实例被 `ELECTRON_RUN_AS_NODE=1` 当成 node 跑了，或启动期就崩了；日志最后一行会写 `the application exited during startup` |
| `409` | 上一次重启还在排队（`pending` 标志没清），等 2 秒再点 |
| 按钮不见了 | bundle 没进 `dsh.profile.bundles`，或客户端 bundle 没构建 |

## 设计取舍

- **先回包再重启**：HTTP 响应必须在进程死掉之前 flush 完，所以 `REPLY_GRACE_MS = 100`
  只留了回包的时间。想让前端看到「重启中」的状态条，得在回包前就开始轮询。
- **helper 从 `%TEMP%` 跑**：不能在插件目录里跑，否则 helper 会持有插件目录的句柄，
  下一次 `pnpm` 更新解不开。
- **只认 `process.ppid`**：Windows 上 Host 是主进程的直接子进程。父 pid 为 0 或负数说明
  Host 被孤儿化或是别的启动路径拉起的，这时不猜，直接报错。

## License

MIT
