# ProjectMsg · 项目管理中台

本地 / 局域网 Web 中台：总览多台电脑上的 vibecoding 项目状态、进展、端口/网址、GitHub、部署与商店运营。  
数据默认落在本机 **PostgreSQL**；Hub 监听 `0.0.0.0`，其它电脑通过 Agent 上报扫描结果。

## 快速开始

1. 确认本机 PostgreSQL 已启动，并已有库（首次可用超级用户创建）：

```sql
CREATE DATABASE projectmsg OWNER postgres;
```

2. 配置环境变量：

```bash
# macOS / Linux
cp .env.example .env

# Windows
copy .env.example .env

# 编辑 .env：DATABASE_URL、HOST、LLM_* 等
```

示例：

```env
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/projectmsg
HOST=0.0.0.0
PORT=8800
NODE_ROLE=hub
SCAN_DEPTH=2
LLM_API_KEY=sk-...
LLM_ENABLED=true
```

macOS 可用 Homebrew 安装依赖：

```bash
brew install node@22 postgresql@18
brew services start postgresql@18
createdb projectmsg
```

扫描根目录在 macOS 上请填 POSIX 路径（如 `/Users/你/Projects`），不要用 `D:\...` 或 UNC `\\host\share`；网络盘请先挂到 `/Volumes/...`。
3. 安装并启动：

```bash
npm install
npm run db:ping
npm run dev
```

- 本机前端：http://127.0.0.1:5177  
- 本机 / 局域网 API：http://\<本机局域网IP\>:8800  
- 生产：`npm run build && npm start`，打开 http://\<IP\>:8800  

> 默认端口为 **8800**（避免与本机其它占用 8790 的服务冲突）。可在 `.env` 的 `PORT` 修改。

## 多机访问与多机扫描

| 角色 | 做什么 |
|------|--------|
| **Hub**（本机） | `NODE_ROLE=hub`，`HOST=0.0.0.0`，跑 `npm run dev` / `npm start`，连同一个 PostgreSQL |
| **Agent**（其它电脑） | 克隆本仓库，配置 `.env` 的 `HUB_URL=http://hub-ip:8800`、`NODE_ROLE=agent`、本机 `scanRoots`，执行 `npm run agent` |

Agent 会周期性扫描本机路径，把项目快照 POST 到 Hub 的 `/api/nodes/sync`。Hub 列表里会显示「远端·节点名」。

可选：在 Hub 的「根目录设置」里直接填 UNC 路径（如 `\\other-pc\share\code`），由 Hub 本机去扫网络共享。

界面顶栏 **多机节点** 可查看各节点在线状态与扫描根目录。

## 数据存储

| 位置 | 内容 |
|------|------|
| PostgreSQL `projectmsg` | settings / nodes / projects / marketplace / reports |
| `.env` | `DATABASE_URL`、LLM Key、监听地址（勿提交） |
| `data/node.json` | 本机节点 id（可忽略进 git） |

旧版 `data/*.json` 会在库为空时自动迁移进 PostgreSQL。`data/` 已加入 `.gitignore`。

## 功能摘要

- 多根目录扫描 + **扫描深度**（嵌套目录 / monorepo）
- 列表 / 看板、搜索筛选、回收站
- GitHub 同步 / 定时同步 / `gh` 建仓
- 本地 npm 脚本启停（可选脚本）
- 云服务器 SSH 部署 + **部署预检**
- 商店运营、AI 解读 / 周报（需启用 LLM）
- 多机 Agent 扫描汇总

## 状态约定

| 状态 | 含义 |
|------|------|
| `planning` | 规划中 |
| `developing` | 开发中 |
| `on_github` | 已推到 GitHub |
| `deployed` | 已部署 |
| `paused` / `archived` / `trashed` | 暂停 / 归档 / 回收站 |

## API 摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 + 节点信息 |
| GET/PUT | `/api/settings` | 扫描根、深度、主题、LLM |
| GET | `/api/projects` | 扫描并合并元数据（含远端节点） |
| POST | `/api/nodes/sync` | Agent 上报扫描结果 |
| GET | `/api/nodes` | 节点列表 |
| POST | `/api/projects/:id/deploy/precheck` | 部署预检 |
| POST | `/api/projects/:id/runtime/start` | `{ "script": "dev" }` 可选 |

## 安全提示

- 不要把 `.env` 或含 API Key 的 JSON 提交进 Git。
- 局域网开放 `8800` 时，建议设置 `AGENT_TOKEN`，Agent 请求头带 `X-Agent-Token`。
- 防火墙放行 TCP `8800`（以及开发态 `5177`）。
