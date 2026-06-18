(function () {
  "use strict";

  const courseAliasGroups = [
    ["线性代数", "线代", "linear algebra"],
    ["线性代数II", "线代II", "线性代数2", "线代2", "线代二", "线性代数二"],
    ["高等代数", "高代"],
    ["数学分析", "数分"],
    ["微积分", "vif", "微甲", "微乙", "微积分甲", "微积分乙", "calculus"],
    ["概率论", "概率统计", "概统", "probability"],
    ["数据结构", "DS", "FDS"],
    ["计算机系统", "ICS", "CSAPP"],
    ["数字逻辑", "数逻", "digital logic"],
    ["数字系统", "digital system"],
    ["离散数学", "离散结构", "离散", "discrete math"],
    ["大学物理", "普通物理", "大物", "普物", "physics"],
    ["信号与系统", "信号", "signals and systems"],
    ["电路原理", "电路", "circuits"],
    ["操作系统", "OS", "operating system"],
    ["数据库", "DB", "database"],
    ["计算机网络", "计网", "computer network"],
    ["密码学", "crypto", "cryptography"],
    ["汇编", "ASM", "assembly"],
    ["机器学习", "ML", "machine learning"],
    ["人工智能", "AI", "artificial intelligence"],
    ["算法", "algorithm"],
    ["C语言", "C程", "C programming"]
  ];

  const generatedTeacherAliasGroups = Array.isArray(globalThis.CC98_SMART_SEARCH_TEACHER_ALIAS_GROUPS)
    ? globalThis.CC98_SMART_SEARCH_TEACHER_ALIAS_GROUPS
    : [];

  const teacherAliasGroups = [
    ...generatedTeacherAliasGroups,
    ["韩刚", "hg"]
  ];

  const segmentTerms = [
    "老师",
    "期中",
    "期末",
    "考试",
    "试卷",
    "答案",
    "习题",
    "作业",
    "教材",
    "网课",
    "复习",
    "资料",
    "历年",
    "回忆卷",
    "春夏",
    "秋冬",
    "夏学期",
    "冬学期",
    "ii",
    "iii",
    "iv"
  ];

  globalThis.CC98_SMART_SEARCH_LEXICON = {
    courseAliasGroups,
    teacherAliasGroups,
    aliasGroups: [...courseAliasGroups, ...teacherAliasGroups],
    segmentTerms
  };
})();
