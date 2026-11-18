# SDO 流程 preset（无插件版）

只含**流程**，不含任何 SDO 业务代码：人格一段、skill 目录、skill 加载工具、问答工具。

## 安装

```bash
# 在宿主里（需要安装权限）
plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后新建会话时选 `SDO Flow`（`preset-sdo-flow`）。**不要**覆盖已装的 SDO 插件 preset，两者互斥。

## 它会带来什么

| 提供 | 作用 |
|---|---|
| `@deepseek-ai/dsh-persona` | 一段固定前言：先对齐、可审计、签字只能由人完成 |
| `@deepseek-ai/dsh-skill` + `dsh-skill-filesystem` | 扫描 `<项目根>/.dsh/skills`，发现 `sdo-flow` |
| `@deepseek-ai/dsh-tool-skill` | 让模型能按需加载 skill 正文与 references |
| `@deepseek-ai/dsh-tool-ask-user` | **人签通道**：三选项（签 / 有异议 / 拒绝） |

## 它不会带来什么

- 没有 `sdo_*` 工具、没有数据库、没有事件表、没有 signerd。
- 不提供文件/命令工具：默认宿主已有；精简宿主请放开 `cordis.patch.yml` 里注释的三行。

## 已知边界

- 人签是**选项**，不是密码学签名；同 uid 可改文件。
- 账本是 Markdown，审计靠 git 历史，不防篡改。
- 门禁靠人按清单判读；没有 `judgeStage` 那种机器强制。
