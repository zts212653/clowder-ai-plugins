# Word 文档编辑

简体中文 · [English](README.en.md)

在兼容的 Clowder AI 宿主中打开 Word 文档，进行协作编辑、评论和修订。

## 开始使用

1. 安装并启用 `@clowder-ai/genoffice-docx`。
2. 在宿主提供的文档入口打开 DOCX 文件，使用文档编辑器完成加载、编辑、评论和修订操作。

支持的文件类型为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`。需要宿主支持对应的内容编辑器界面及文档访问控制；单独安装包不会生成一份独立文档授权。

## 文档隔离

编辑器在独立来源的沙箱 iframe 中运行，携带语义物化工作线程。宿主管理安装、文档访问、窗口与生命周期；包只提供编辑器和工作线程资源，不读取宿主环境或越过隔离来源。

编辑器只在宿主已授权的文档界面内工作。

宿主管理安装、授权和启停。英文文档是独立文件，互链不代表页面已支持自动语言切换。
