(function () {
  "use strict";

  const mathAliasGroups = [
    ["高等数学", "高数", "advanced mathematics"],
    ["线性代数", "线代", "linear algebra"],
    ["线性代数II", "线代II", "线性代数2", "线代2", "线代二", "线性代数二"],
    ["高等代数", "高代"],
    ["抽象代数", "近世代数", "abstract algebra"],
    ["数学分析", "数分"],
    ["复变函数", "复变", "complex analysis"],
    ["实变函数", "实变", "real analysis"],
    ["常微分方程", "常微分", "ODE"],
    ["偏微分方程", "偏微分", "PDE"],
    ["泛函分析", "泛函", "functional analysis"],
    ["微积分", "vif", "微甲", "微乙", "微积分甲", "微积分乙", "calculus"],
    ["概率论", "概率统计", "概统", "probability theory"],
    ["数理统计", "统计推断", "mathematical statistics"],
    ["统计学", "统计", "statistics"],
    ["随机过程", "stochastic process"],
    ["运筹学", "operations research"],
    ["数值分析", "数值计算", "numerical analysis"],
    ["最优化", "优化理论", "optimization"],
    ["拓扑学", "拓扑", "topology"],
    ["微分几何", "diff geometry"],
    ["图论", "graph theory"],
    ["组合数学", "combinatorics"],
    ["信息论", "information theory"],
    ["逻辑学", "logic"]
  ];

  const physicsChemistryAliasGroups = [
    ["大学物理", "普通物理", "大物", "普物", "physics"],
    ["力学", "mechanics"],
    ["理论力学", "theoretical mechanics"],
    ["电磁学", "electromagnetism"],
    ["热学", "热力学", "thermodynamics"],
    ["光学", "optics"],
    ["原子物理", "atomic physics"],
    ["量子力学", "量力", "quantum mechanics"],
    ["统计物理", "统物", "statistical physics"],
    ["固体物理", "solid state physics"],
    ["电动力学", "electrodynamics"],
    ["大学化学", "普通化学", "大化", "普化", "general chemistry"],
    ["无机化学", "无机", "inorganic chemistry"],
    ["有机化学", "有机", "organic chemistry"],
    ["分析化学", "分析", "analytical chemistry"],
    ["物理化学", "物化", "physical chemistry"],
    ["结构化学", "结构", "structural chemistry"],
    ["化工原理", "principles of chemical engineering"],
    ["高分子化学", "高化", "polymer chemistry"],
    ["材料化学", "materials chemistry"]
  ];

  const lifeMedicalAliasGroups = [
    ["普通生物学", "普生", "biology"],
    ["生物化学", "生化", "biochemistry"],
    ["分子生物学", "分子", "molecular biology"],
    ["细胞生物学", "细胞", "cell biology"],
    ["遗传学", "genetics"],
    ["微生物学", "微生物", "microbiology"],
    ["生理学", "physiology"],
    ["人体解剖学", "解剖学", "anatomy"],
    ["免疫学", "immunology"],
    ["病理学", "pathology"],
    ["药理学", "pharmacology"],
    ["流行病学", "流病", "epidemiology"],
    ["生物信息学", "生信", "bioinformatics"],
    ["神经科学", "neuroscience"],
    ["组织胚胎学", "组胚", "histology"],
    ["诊断学", "diagnostics"],
    ["内科学", "内科", "internal medicine"],
    ["外科学", "外科", "surgery"]
  ];

  const computerAliasGroups = [
    ["程序设计基础", "程设", "programming"],
    ["C语言", "C程", "C programming"],
    ["C++程序设计", "C++", "CPP"],
    ["Java程序设计", "Java"],
    ["Python程序设计", "Python"],
    ["数据结构", "DS", "FDS"],
    ["算法设计", "算法", "algorithm"],
    ["高级数据结构", "ADS"],
    ["面向对象程序设计", "面向对象", "OOP"],
    ["计算机组成", "计算机组成原理", "计组", "组成原理"],
    ["计算机体系结构", "体系结构", "computer architecture"],
    ["计算机系统", "ICS", "CSAPP"],
    ["数字逻辑", "数逻", "digital logic"],
    ["数字系统", "digital system"],
    ["离散数学", "离散结构", "离散", "discrete math"],
    ["形式语言与自动机", "自动机", "formal languages"],
    ["操作系统", "OS", "operating system"],
    ["数据库", "DB", "database"],
    ["计算机网络", "计网", "computer network"],
    ["编译原理", "编译", "compiler"],
    ["软件工程", "软工", "software engineering"],
    ["信息安全", "信安", "information security"],
    ["密码学", "crypto", "cryptography"],
    ["汇编", "ASM", "assembly"],
    ["并行计算", "parallel computing"],
    ["分布式系统", "distributed system"],
    ["云计算", "cloud computing"],
    ["大数据", "big data"],
    ["数据挖掘", "DM", "data mining"],
    ["机器学习", "ML", "machine learning"],
    ["深度学习", "DL", "deep learning"],
    ["人工智能", "AI", "artificial intelligence"],
    ["自然语言处理", "NLP", "natural language processing"],
    ["计算机视觉", "CV", "computer vision"],
    ["计算机图形学", "图形学", "CG", "computer graphics"],
    ["人机交互", "HCI", "human computer interaction"],
    ["计算理论", "theory of computation"],
    ["区块链", "blockchain"]
  ];

  const electricalAliasGroups = [
    ["电路原理", "电路", "circuits"],
    ["模拟电子技术", "模电", "analog electronics"],
    ["数字电子技术", "数电", "digital electronics"],
    ["电子电路", "electronic circuits"],
    ["信号与系统", "信号", "signals and systems"],
    ["数字信号处理", "DSP", "digital signal processing"],
    ["通信原理", "通信", "communication principles"],
    ["电磁场与电磁波", "电磁场", "electromagnetic field"],
    ["自动控制原理", "自控", "automatic control"],
    ["控制理论", "control theory"],
    ["电力电子技术", "电力电子", "power electronics"],
    ["电机学", "electric machinery"],
    ["电力系统", "power system"],
    ["嵌入式系统", "嵌入式", "embedded system"],
    ["微机原理", "微机", "microcomputer principles"],
    ["单片机", "MCU"],
    ["可编程逻辑器件", "FPGA"],
    ["集成电路", "集成电路设计", "integrated circuit"],
    ["超大规模集成电路", "VLSI"],
    ["半导体物理", "半导体", "semiconductor physics"],
    ["电子设计自动化", "EDA"]
  ];

  const engineeringAliasGroups = [
    ["工程图学", "工程制图", "engineering drawing"],
    ["机械制图", "mechanical drawing"],
    ["机械原理", "mechanism"],
    ["机械设计", "machine design"],
    ["材料力学", "material mechanics"],
    ["流体力学", "fluid mechanics"],
    ["工程热力学", "engineering thermodynamics"],
    ["传热学", "heat transfer"],
    ["控制工程", "control engineering"],
    ["机器人学", "robotics"],
    ["计算机辅助设计", "CAD"],
    ["有限元分析", "有限元", "FEM"],
    ["材料科学基础", "材基", "materials science"],
    ["材料物理", "materials physics"],
    ["材料成型", "material forming"],
    ["土木工程概论", "土木概论"],
    ["结构力学", "structural mechanics"],
    ["混凝土结构", "concrete structure"],
    ["土力学", "soil mechanics"],
    ["工程地质", "engineering geology"],
    ["建筑材料", "building materials"],
    ["测量学", "surveying"],
    ["工程训练", "金工实习", "metalworking practice"]
  ];

  const businessEconomicsAliasGroups = [
    ["经济学原理", "经原", "principles of economics"],
    ["微观经济学", "微经", "microeconomics"],
    ["宏观经济学", "宏经", "macroeconomics"],
    ["计量经济学", "计量", "econometrics"],
    ["金融学", "金融", "finance"],
    ["公司金融", "corporate finance"],
    ["会计学", "会计", "accounting"],
    ["财务管理", "财管", "financial management"],
    ["管理学", "管理", "management"],
    ["市场营销", "营销", "marketing"],
    ["组织行为学", "组行", "organizational behavior"],
    ["人力资源管理", "人力", "HRM"],
    ["战略管理", "strategy"],
    ["运营管理", "operations management"],
    ["博弈论", "game theory"],
    ["投资学", "investment"],
    ["国际贸易", "国贸", "international trade"],
    ["产业经济学", "产业经济"],
    ["公共经济学", "public economics"]
  ];

  const humanitiesSocialAliasGroups = [
    ["马克思主义基本原理", "马原"],
    ["毛泽东思想和中国特色社会主义理论体系概论", "毛概"],
    ["中国近现代史纲要", "史纲"],
    ["思想道德与法治", "思修", "德法"],
    ["形势与政策", "形策"],
    ["军事理论", "军理"],
    ["大学英语", "大英", "college english"],
    ["英语", "english"],
    ["日语", "japanese"],
    ["德语", "german"],
    ["法语", "french"],
    ["中国文学", "chinese literature"],
    ["外国文学", "foreign literature"],
    ["文学理论", "literary theory"],
    ["语言学概论", "语概", "linguistics"],
    ["社会学", "sociology"],
    ["心理学", "普通心理学", "psychology"],
    ["教育学", "pedagogy"],
    ["法理学", "jurisprudence"],
    ["宪法学", "constitutional law"],
    ["民法", "civil law"],
    ["刑法", "criminal law"],
    ["行政法", "administrative law"],
    ["国际法", "international law"],
    ["政治学", "political science"],
    ["公共管理", "public administration"],
    ["新闻学", "journalism"],
    ["传播学", "communication"]
  ];

  const earthEnvironmentAgricultureAliasGroups = [
    ["环境科学", "environmental science"],
    ["环境工程", "environmental engineering"],
    ["环境化学", "environmental chemistry"],
    ["环境监测", "environmental monitoring"],
    ["生态学", "ecology"],
    ["城市规划", "urban planning"],
    ["建筑设计", "architectural design"],
    ["建筑史", "architectural history"],
    ["景观设计", "landscape design"],
    ["地理信息系统", "GIS"],
    ["遥感", "remote sensing"],
    ["地理学", "geography"],
    ["地质学", "geology"],
    ["大气科学", "气象", "atmospheric science"],
    ["海洋科学", "marine science"],
    ["农学", "agronomy"],
    ["植物学", "botany"],
    ["动物学", "zoology"],
    ["园艺学", "horticulture"],
    ["土壤学", "soil science"],
    ["作物学", "crop science"]
  ];

  const courseAliasGroups = [
    ...mathAliasGroups,
    ...physicsChemistryAliasGroups,
    ...lifeMedicalAliasGroups,
    ...computerAliasGroups,
    ...electricalAliasGroups,
    ...engineeringAliasGroups,
    ...businessEconomicsAliasGroups,
    ...humanitiesSocialAliasGroups,
    ...earthEnvironmentAgricultureAliasGroups
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

  const shortQueryExpansions = {
    "梅": ["梅花", "梅雨", "青梅"]
  };

  globalThis.CC98_SMART_SEARCH_LEXICON = {
    courseAliasGroups,
    teacherAliasGroups,
    aliasGroups: [...courseAliasGroups, ...teacherAliasGroups],
    segmentTerms,
    shortQueryExpansions
  };
})();
