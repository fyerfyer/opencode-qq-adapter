# AGENTS.md

## Git 提交规则

- **每次 `git commit` 之前必须停下来，先向用户展示本次改动摘要、关键 diff 或文件列表，以及已运行的测试结果。**
- 必须等待用户明确回复“可以提交 / commit / 通过审核”后，才能执行 `git commit`。
- 不要在任务结束时自动提交，也不要把“实现完成”等同于“允许提交”。
- 未经用户明确批准，不得执行 `git commit --amend`、`git rebase`、`git reset` 改写历史，或 `git push`。
- 如果用户要求先审查，保持改动在工作区，不要为了“干净”而自行提交。

## 文档

- `docs/` 是本地设计/计划笔记，已加入 `.gitignore`，不要提交。
- 需要提交 README、DESIGN 等项目文档时，同样遵守上面的提交前审查规则。

## 验证

- 提交前至少运行与改动相关的测试；可用时运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`。
- 在提交审查消息中说明哪些命令通过、哪些未运行，以及原因。
