# Paperclip 本地启动与复用指南（macOS）

记录日期：2026-11-05。适用于当前源码仓库在 macOS Apple Silicon 上的本地开发启动。
其他环境的通用说明见 [DEVELOPING.md](DEVELOPING.md)。

Node.js 和 pnpm 已改为用户级全局安装（`~/.local/bin`）；Rust 仍安装在项目内。
使用内置 PostgreSQL，无需单独安装数据库。重复的项目内 Node.js 和 pnpm 已清理。
Web 服务仅监听本机 `127.0.0.1:3100`，采用 `local_trusted` 模式。

## 1. 以后日常启动：直接复制这一段

在终端执行。若仓库移动了，只需修改第一行路径：

```sh
cd /Users/alex/Code/opc/ai-company/paperclip

export PATH="$HOME/.local/bin:$PWD/.paperclip/tooling/cargo/bin:$PATH"
export CARGO_HOME="$PWD/.paperclip/tooling/cargo"
export RUSTUP_HOME="$PWD/.paperclip/tooling/rustup"

pnpm dev:once
```

出现 `Server startup recovery complete on 127.0.0.1:3100` 后，打开：

- 页面：<http://127.0.0.1:3100>
- 健康接口：<http://127.0.0.1:3100/api/health>

启动终端需要保持运行，关闭终端会影响服务。`dev:once` 表示不启用文件监听，
仍然是持续运行的开发服务器，并且默认自动应用待执行的本地数据库迁移。
写代码需要监听变更时，可改用：

```sh
pnpm dev
```

两种启动方式选择一种即可。已有服务时，先按下文查看状态；切换模式前先停止旧服务。
首次 Rust 编译耗时较长，本次约 6 分钟；后续启动可复用已生成的二进制。
源码或构建输入变化后，可能再次触发编译。

以上 `export` 只作用于当前终端。Node.js 和 pnpm 的全局路径已在本机终端配置中；
新终端启动 Paperclip 时仍需设置项目内 Rust 的路径和环境变量。

## 2. 查看状态、验证、停止

在另一个终端先执行第 1 节的 `cd` 和三条 `export`，然后查看注册状态：

```sh
pnpm dev:list
```

验证页面和 API：

```sh
curl --fail --silent --show-error http://127.0.0.1:3100/api/health
curl --silent --show-error --output /dev/null --write-out 'HTTP %{http_code}\n' http://127.0.0.1:3100/
curl --fail --silent --show-error http://127.0.0.1:3100/api/companies
```

预期结果：

- 健康接口包含 `"status":"ok"`、`"authReady":true`、`"bootstrapStatus":"ready"`。
- `startupRecovery.phase` 为 `ready`。
- 页面返回 `HTTP 200`。
- 当前实例应包含 XHZY 公司；迁移后保留了之前创建的 8 位成员。

停止服务可以在启动终端按 `Ctrl+C`，也可以执行：

```sh
pnpm dev:stop
```

现在统一使用默认目录 `~/.paperclip/`，启动、查看和停止时均无需传入 `--data-dir`。

## 3. 首次安装或换电脑时的完整步骤

当前电脑已经完成本节，不需要每次重复执行。

### 3.1 准备条件

- 已有本仓库源码、可用的 `npm` 和网络连接。
- macOS 已安装 Xcode Command Line Tools 或完整 Xcode，可用 `xcode-select -p` 检查。
- 当前源码要求 Node.js 24.11+，本次采用 pnpm 9.15.4。
- Rust 版本跟随 `packages/paperclip-runner/rust-toolchain.toml`，本次为 1.97.1。
- 本指南使用内置数据库，运行前不要设置外部 `DATABASE_URL`。
  若终端已有自定义 `PAPERCLIP_*` 实例配置，请先确认不会覆盖本指南的本地实例路径。

### 3.2 安装用户级全局 Node.js 和 pnpm

```sh
cd /Users/alex/Code/opc/ai-company/paperclip

npm install --global --prefix "$HOME/.local" node@24 pnpm@9.15.4

export PATH="$HOME/.local/bin:$PATH"

node --version
pnpm --version
```

本机已完成安装，Node.js 为 `v24.22.2`、pnpm 为 `9.15.4`。
换电脑时需要确保 `~/.local/bin` 加入终端的 `PATH`。如果该目录已有同名命令，
先确认其归属再处理冲突，不要直接覆盖其他工具。
`node@24` 会安装当时可用的 24.x 版本；项目升级后，以 `.nvmrc`、`package.json`
和开发文档中的要求为准。

### 3.3 安装依赖

```sh
pnpm install --frozen-lockfile --store-dir .pnpm-store
```

这一步会联网下载依赖并执行安装脚本。保留仓库锁文件；不要为了本地安装而随意重写它。

### 3.4 安装 Rust 到项目目录

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o .paperclip/tooling/rustup-init.sh

export CARGO_HOME="$PWD/.paperclip/tooling/cargo"
export RUSTUP_HOME="$PWD/.paperclip/tooling/rustup"

sh .paperclip/tooling/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain 1.97.1

export PATH="$PWD/.paperclip/tooling/cargo/bin:$PATH"

cargo --version
```

如果仓库的 `rust-toolchain.toml` 已更新，应将安装命令中的版本同步替换。
构建时 Rust 会根据仓库要求补装组件，例如 `rustfmt`。

### 3.5 先构建插件 SDK，再启动

本次干净检出中，启动器在构建插件 SDK 之前就运行 Runner 状态检查，
导致找不到 `@paperclipai/plugin-sdk/dist/index.js`。先构建一次 SDK 即可补齐产物：

```sh
pnpm --filter @paperclipai/plugin-sdk build
pnpm dev:once
```

启动器随后会自动执行必要的数据库迁移、Runner TypeScript 构建、原生 Runner 编译，
以及插件 SDK 构建，再启动 API 和 Vite 开发页面。首次构建需要联网下载 Rust 依赖。

## 4. 数据和工具保存在哪里

除以 `~/` 开头的用户目录外，以下路径均相对于仓库根目录：

| 路径 | 用途 |
| --- | --- |
| `~/.local/lib/node_modules/`（仓库外） | 用户级全局 Node.js 和 pnpm，入口在 `~/.local/bin/` |
| `.paperclip/tooling/cargo/` | Cargo、Rust 工具入口和依赖缓存 |
| `.paperclip/tooling/rustup/` | Rust 工具链 |
| `.pnpm-store/` | pnpm 下载缓存 |
| `~/.paperclip/instances/default/db/` | 当前实例的 PostgreSQL 数据 |
| `~/.paperclip/instances/default/data/backups/` | 自动数据库备份目录 |
| `.paperclip/local-data` | 指向 `~/.paperclip/` 的兼容符号链接，让旧的 Agent 指令绝对路径继续有效；不是另一份数据库 |
| `~/.paperclip-empty-backup-20261105/` | 迁移前空实例的保留备份 |
| `packages/paperclip-runner/runner/target/` | Rust 构建缓存 |

2026-11-05 已将包含 XHZY 和 8 位成员的实例从项目目录迁移到 `~/.paperclip/`。
以后直接使用 `pnpm dev` 或 `pnpm dev:once`，会继续使用已保存的公司和任务数据。
旧位置保留兼容链接，是因为 Agent 配置中已有指向那里指令文件的绝对路径。
移动仓库或移除该链接前，需要通过 Paperclip 的配置接口迁移这些引用。
不要把删除数据库目录当成普通的重启步骤；删除它会丢失本地数据。
项目内的工具目录、兼容链接和构建产物已被仓库忽略，不需要提交。

## 5. 本次遇到的问题与处理方式

| 现象 | 原因与处理 |
| --- | --- |
| 默认 Node.js 为 22.x | 不满足仓库的 24.11+ 要求；确认 `~/.local/bin` 在 `PATH` 中，并执行 `node --version` 检查全局版本。 |
| `node_modules` 不存在 | 执行第 3.3 节安装。 |
| 找不到 `plugin-sdk/dist/index.js` | 在仓库根目录执行 `pnpm --filter @paperclipai/plugin-sdk build` 后重试。 |
| `cargo: command not found` | 完成 Rust 安装，并设置第 1 节的 `PATH`、`CARGO_HOME`、`RUSTUP_HOME`。 |
| Codex 沙箱内 `curl` 无法连接，但端口已监听 | 本次环境限制了沙箱访问宿主机 localhost；在普通 macOS 终端验证，或让 Codex 申请权限后验证。 |
| `database_backup_missing` | 新实例尚未生成第一次备份；本次健康接口仍为 `ok`，自动备份已启用。 |
| 启动横幅提示 Agent JWT 缺失 | Web 页面可以启动；这不代表 Agent 执行配置已完成。配置 Agent 时继续按产品引导和开发文档操作。 |

如果 3100 端口被占用，可先确认进程归属：

```sh
lsof -nP -iTCP:3100 -sTCP:LISTEN
```

取得 PID 后，在 macOS 上检查它的工作目录：

```sh
lsof -a -p <PID> -d cwd
```

本次监听进程的工作目录是本仓库的 `server/`。
若属于其他程序或其他工作区，不要直接结束它；先确认应启动的是哪个实例。

## 6. 首次启动验证记录（迁移前）

- 启动方式：`pnpm dev:once --data-dir .paperclip/local-data`。
- 页面：`http://127.0.0.1:3100/` 返回 HTTP 200。
- 健康接口：`status=ok`、`authReady=true`、`bootstrapStatus=ready`、`startupRecovery.phase=ready`。
- 公司接口：返回 `[]`，为全新本地实例。
- 已核实监听进程工作目录为当前仓库的 `server/`。
- 本次只补齐本地工具、依赖和构建产物，没有修改应用源码。
- 未验证实际 Agent 运行，也未运行整库测试；上述记录证明本地 Web 服务和数据库启动成功。

## 7. 默认数据目录迁移

首次启动曾使用 `--data-dir .paperclip/local-data`，而不带参数的启动命令会使用
`~/.paperclip/`，两者原本是不同数据库。这是此前启动后看不到 XHZY 的原因。
现已统一到默认目录，并将原空实例完整保留为上表所列备份。
XHZY 的公司名称与路径标识不同：页面入口为 <http://localhost:3100/XHZ/dashboard>。
