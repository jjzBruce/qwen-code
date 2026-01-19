# Qwen Code 本地打包指南

本文档介绍如何将 Qwen Code 项目打包成本地可执行文件，并以 `qwenl` 命令运行（避免与已安装的 `qwen` 命令冲突）。

## 准备工作

确保您已安装以下工具：

- Node.js (v18 或更高版本)
- npm

## 修改配置

在打包之前，需要修改项目配置以避免与已安装的 Qwen Code 冲突：

### 1. 修改 package.json

编辑 `package.json` 文件，修改以下字段：

```json
{
  "name": "qwen-code-local",
  "bin": {
    "qwenl": "./dist/index.js"
  }
}
```

### 2. 构建项目

运行构建命令生成可执行文件：

```bash
npm run build
```

## 本地安装

### 方法一：使用 npm link（推荐）

在项目根目录下运行：

```bash
npm link
```

这将在您的系统中创建 `qwenl` 命令的符号链接。

### 方法二：全局安装

在项目根目录下运行：

```bash
npm install -g .
```

这将全局安装本地版本，命令名为 `qwenl`。

## 验证安装

安装完成后，您可以使用以下命令验证：

```bash
qwenl --help
```

如果显示帮助信息，则说明安装成功。

## 卸载本地版本

如果需要卸载本地版本，可以使用以下命令：

```bash
npm uninstall -g qwen-code-local
# 或者如果使用 npm link
npm unlink -g qwen-code-local
```

## 注意事项

1. 本地版本不会影响您已安装的 `qwen` 命令
2. `qwenl` 命令将使用本地构建的版本
3. 如果需要更新本地版本，请重新运行构建和安装命令
4. 确保您的 PATH 环境变量包含 npm 全局安装目录

## 故障排除

如果遇到命令找不到的问题，请检查：

1. npm 全局安装目录是否在 PATH 中
2. 构建是否成功完成
3. package.json 中的配置是否正确
