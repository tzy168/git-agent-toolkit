统计（来自 git 事实，不要自己加减）：
{{stats}}

提交记录：
{{commits}}

Pass A 提取的全部变更点（JSON）：
{{changePoints}}

仓库现有测试清单：
{{existingTests}}

Pass B：基于以上变更点推导测试用例。每个变更点至少一条用例；优先级按 system 规则判定；alreadyCovered 对照现有测试清单。
