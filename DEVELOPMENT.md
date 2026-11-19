# 开发与维护笔记

面向**本仓库的维护者**，不是使用者。使用说明在 `README.md`。

## 1. 本仓库自己也在用 sdo-flow

`.sdo/` 是本仓库的过程记录：意图、计划、卡、签字、评审、读数、偏差台账。改动流程本身时要走同一套流程（先卡后写、计划评审、多轮评审、人签、读数门），不要绕过。台账在 `.sdo/台账.md`，编号连续、只追加。

## 2. 改了 skill 之后

- 检查：`node skills/sdo-flow/scripts/check.mjs`（0 错 0 警才提交）、`node skills/sdo-flow/scripts/check.mjs --presets`（preset 与发布快照一致）。
- 阶段门：`node skills/sdo-flow/scripts/gate.mjs`（`--list`/`G_xxx`/`--file`/`--json`）。
- 视图：`node skills/sdo-flow/scripts/view.mjs <state|queue|board|ledger|signs|plan|next>`。

## 3. 已安装副本的同步（每个里程碑收口后必做）

安装目录是本机环境（例如本仓库的 `.dsh/skills/sdo-flow/`，已被 `.git/info/exclude` 忽略），不属于提交内容。里程碑签字落盘后：

```bash
git archive <里程碑收口提交> skills/sdo-flow | tar -x -C /tmp/skill-sync
rsync -a --delete /tmp/skill-sync/skills/sdo-flow/ .dsh/skills/sdo-flow/
diff -r skills/sdo-flow .dsh/skills/sdo-flow      # 无输出才算同步完成
```

从提交导出而不是直接拷工作树，避免把进行中的卡带进安装目录。没同步的后果：下一个会话加载的是旧流程，且不会报错。

## 4. 版本与发布

- 仓库里只有 skill 的源（`SKILL.md`、`references/`、`presets/`、`templates/`、`scripts/`）与流程产物 `.sdo/`。
- 发布 = 把 `skills/sdo-flow/` 整体拷进目标 agent 的 skills 目录；没有构建步骤、没有依赖安装。
- 脚本必须保持零依赖（只用 Node 内建模块），Windows/Linux 都要能跑；改动脚本时同步 `SKILL.md` §11 的命令示例。

## 5. 提交纪律

- 一卡两笔：代码/文档一笔、卡与台账一笔。
- 不 push；推送由维护者决定。
- 历史签字文件只追加、不改原文；要更正就在文件末尾追加「签后更正」段。
