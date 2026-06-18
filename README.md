# CC98 Smart Search

一个面向 CC98 的轻量浏览器搜索增强插件。

当前 MVP 支持：

- 多关键词搜索
- 模糊别名扩展
- `+关键词` 必须包含
- `-关键词` 排除
- 综合、最新、热门三种 SearchRank 排序

插件只增强 CC98 的主题/全站/版内搜索。用户搜索和版面搜索暂时交给 CC98 原站处理。

## 安装验证

1. 打开 Chrome：`chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目的 `extension` 目录
5. 打开 `https://www.cc98.org/` 并保持登录
6. 在顶部搜索框输入 `线性代数 期末` 或 `+线代 -答案 期末`
7. 按 Enter 或点击搜索图标

页面中出现 `CC98 Smart Search` 增强结果面板即为加载成功。

## 本地检查

```powershell
npm run build
```

该命令会检查 content script 语法并校验 `manifest.json`。
