# 架构与扩展

## 五层职责

| 层       | 代码                                                                      | 责任                                               |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| 应用外壳 | `app/workspace.tsx`、`app/use-workspace.ts`、`app/use-device-profiles.ts` | 导航、全局设备及统一名称、助手会话、同步、任务面板 |
| 业务模块 | `app/modules/`                                                            | 独立的模块状态、页面和操作流程                     |
| 共享协议 | `shared/contracts.ts`、`shared/paths.ts`、`shared/devices.ts`             | `/v1` 数据契约、备注校验、身份与连接键、路径规则   |
| 本机执行 | `companion/`                                                              | ADB 生命周期、Windows 窗口、Tango 同步、任务调度   |
| 云端存储 | `app/api/devices/route.ts`、`app/api/history/route.ts`、`db/`、`drizzle/` | 登录用户隔离、设备资料、连接关联、设置、最近记录   |

浏览器只提交类型明确的操作，不传任意命令，也不读取 Windows 文件内容。上传和下载源自系统文件窗口的一次性选择凭证。Tango 通过本机 ADB server 的同步协议传输目录属性和文件流；只有固定的 mkdir、mv、rm 操作需要 ADB shell，所有路径按 POSIX 单引号规则转义。

## 增加业务模块

1. 在 `shared/contracts.ts` 的 `modules` 加入模块清单：`id`、中文名称、路由、图标标识、所需能力。
2. 在 `app/modules/<id>/` 编写组件，接收 `ModuleContext`。通过 `services.bridge<T>()` 访问本机服务，通过 `services.notify()` 提示结果。
3. 在 `app/modules/registry.tsx` 注册组件和 Lucide 图标。导航及 `/<id>` 路由自动接入；刷新与浏览器返回保持对应页面。
4. 如果需要新的本机能力，在 `companion/` 新增服务，给 `server.ts` 增加经过 Zod 校验的 `/v1/<module>/…` 操作，并将能力名加入助手状态。
5. 设备修改操作复用设备锁或任务队列；不要另开不受调度的 ADB 命令通道。公共协议有不兼容改动时升级 `API_VERSION`，发布新助手。

模块通过 `services.namedDevices` 获取统一的备注与状态，通过 `services.deviceData` 获取已保存资料，不自行按型号或序列号生成主要名称。未命名、离线和关联冲突设备禁止创建文件操作。设置独立于业务模块；每个模块继续复用同一设备选择和任务面板。

示例组件：

```tsx
import type { ModuleContext } from "../types";
export default function ScreenshotModule({ services, serial }: ModuleContext) {
  return (
    <button
      disabled={!serial}
      onClick={async () => {
        try {
          await services.bridge("/screenshots/capture", { serial });
          services.notify("操作完成");
        } catch (error) {
          services.notify((error as Error).message, true);
        }
      }}
    >
      执行模块操作
    </button>
  );
}
```

上面的接口名仅是接入示例，实际 `bridge` 自动加 `/v1`，增加对应本机接口后才能使用。

## 任务与设备锁

创建任务时保存设备序列号、ADB 路径、源路径和目标路径。每个设备有独立的 Promise 队列，同一设备串行执行；不同设备可并行。存在排队、传输或等待重名处理的任务时不能切换 ADB，也不能重启服务。停止服务先拒绝新任务，取消当前任务，再等待在途设备查询结束后执行 kill-server。

上传、下载先写 `.awesomeadb-<任务 ID>.part` 临时文件，完整写入并关闭流后再改为最终名称。跳过目录时跳过其子树；保留两份会同步重定向所有子项；覆盖同名目录会合并子目录，文件继续按冲突策略处理。首版不做断点续传。任务状态只有在全部操作结束且没有错误时才为成功。

助手保留最近最多 100 条已结束任务（活动任务优先保留）；网页刷新可以重新订阅。助手退出后不恢复队列。已完成文件保留；设备断线导致无法清理的临时文件会在任务中列出，恢复连接后可在文件列表中处理。

## 历史与用户隔离

请求身份来自 Sites 转发的登录用户，客户端不能指定用户 ID。ADB 手动路径按 `user_id + machine_id + path_key` 去重，Windows 路径比较忽略大小写和斜杠差异。连接按 `user_id + mode + host + port` 去重，同账号所有电脑共享。环境变量模式写入独立的 preferences 表，不占 10 条路径名额。

每次新增或复用历史使用 D1 `batch` 执行 upsert 和保留最近 10 条的 DELETE；D1 批处理为事务。记录按使用时间排序，同毫秒按 ID 排序保证稳定。备注可独立编辑，不影响使用时间。路径删除需要用户与电脑双重条件；连接删除需要用户条件。

新版电脑标识和受管 ADB 版本保存在 `%LOCALAPPDATA%\AwesomeAdb\config-v2.json`，继承旧配置的电脑标识并保留原文件供回退。新版默认自动准备内置 ADB，页面不再选择路径；旧路径历史只保留兼容数据。云端写入失败进入当前网页内存中的待同步列表，可重试。

## 设备资料、关联与兼容

`device_profiles` 按用户保存独立的设备 ID 和备注；`device_bindings` 按用户唯一绑定 `usb|序列号`、`tcp|地址|端口`、`hardware|SHA256`。`connections.device_id` 关联资料，最近连接被裁剪时资料和绑定不删除。名称重复不代表身份相同。

备注统一使用 `deviceLabelSchema` 去除首尾空格并验证 1～100 个字符。新增设备、关联和重命名都由 `/api/devices` 验证登录用户所有权。绑定冲突使整个 D1 batch 回滚，只有明确传入 `reassign: true` 才重绑。设备资料移除仅删除该用户的资料、绑定及相关连接，不访问设备文件。

0.2.0 的 SQL 迁移只创建表、索引和新增列。旧数据由 `legacyDeviceStatements` 按当前用户的最多 10 条连接幂等升级：保留非空备注，同一地址的连接方式可共享资料，不同地址不按同名合并；空备注保留待补充状态。

助手新增 `device-identity` 能力及只读身份查询，通过固定的 `getprop ro.serialno` / `ro.boot.serialno` 参数取得设备身份并返回摘要，网页不收到原始序列属性。查询缓存按连接清理，生命周期控制先等待身份读取结束再停止或切换 ADB；停止后查询不会重启服务。属性不可读、模拟器或旧助手均可手动关联。

网页先校验再乐观更新有效备注；写入串行，暂时失败保留当前页面备注并标记未同步，允许重试。400/401/403/404/409 等不可重试错误直接显示并移出队列。连接记录依赖备注保存成功；手动重试先同步备注再同步历史。修改备注更新各模块显示，已创建任务的设备序列号不变。

保持 `API_VERSION = 1`；网页仅在能力存在且服务运行时查询身份，旧版助手的其余功能继续工作。任务展示记录对应资料 ID，后续重命名更新显示，而切换当前设备不会改变任务目标。

## 会话边界

- 助手固定监听 `127.0.0.1:27183`，校验 Host 与允许的精确 Origin。
- 发布包只允许目标 Sites 源；开发版额外允许本机 5173 端口。
- 会话建立需要 Windows 本机确认；令牌只保存在网页 sessionStorage 和助手内存中，24 小时到期、助手退出即失效。
- 带 Bearer 令牌的 HTTP 操作与 fetch 事件流共用会话。文件选择结果与会话绑定，只能消费一次，10 分钟到期。
- 网页关闭或请求中止时关闭其尚未完成的 Windows 窗口。
- 文件内容、配对码和授权令牌不进入 D1。
- API 为受控能力接口，不提供终端或任意 shell。

## 受管 ADB 与发布

`managed-adb` 能力追加到 `/v1`。`GET /v1/adb/runtime` 查询版本和更新状态，`POST /v1/adb/check-update` 手动检查，`POST /v1/adb/update` 下载并安全切换，`POST /v1/adb/restart` 在明确确认后重启服务。安装载荷以 SEA assets 内嵌，按版本提取并逐文件校验。更新助手不自动升级已经安装的有效 ADB。

日常设备操作直接使用 smart socket 和 Tango，同步、目录和预览连接都计入访问锁。ADB 可执行文件只用于验证版本和显式启动服务，避免原生 CLI 自动替换其他工具的服务。共用兼容服务时，文件更新与服务生效分别显示；停止服务后不会由更新或后台监听重新启动。

`/api/downloads` 提供下载信息，`/api/downloads/windows` 在正常登录后流式下载私有 R2 安装包，`/api/downloads/site-config` 导出当前站点配置。`/api/downloads/admin` 用私有环境中的所有者邮箱再次授权发布，流式上传并由 R2 校验 SHA-256，成功后切换下载指针。

公开源码使用清理后的全新历史，通用助手不内置个人站点网址。私有 ZIP 仅额外包含站点 JSON，不包含登录凭证或授权令牌。`scripts/package-release.mjs` 分开输出两种包并扫描公开文件。

## 本机接口

| 分组     | 接口                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| 会话     | `GET /v1/health`、`POST /v1/session`、`GET /v1/state`、`GET /v1/events`                                       |
| ADB      | `POST /v1/adb/configure`、`/start`、`/stop`                                                                   |
| 设备     | `POST /v1/devices/refresh`、`/connect`、`/pair`、`/disconnect`、`/tcpip`；`GET /v1/devices/identity?serial=…` |
| 文件     | `GET /v1/files`、`POST /v1/files/preview`、`/mkdir`、`/rename`                                                |
| 本机窗口 | `POST /v1/dialog`                                                                                             |
| 任务     | `POST /v1/jobs`、`/v1/jobs/:id/cancel`、`/retry`、`/resolve`                                                  |
| 退出     | `POST /v1/shutdown`                                                                                           |

云端 `/api/history` 与 `/api/devices` 均支持 GET、POST 和 DELETE。`/api/devices` POST 接收 `save`（备注与绑定）或 `link`（已有资料的绑定），DELETE 接收设备资料 ID。接口字段详见 `shared/contracts.ts`、`shared/devices.ts` 和 `server.ts` 的 Zod 输入校验。
