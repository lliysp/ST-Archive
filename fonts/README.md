# fonts/ · 可选的内置字体

这个目录用来放**可选**的字体文件。放与不放，扩展都能跑——只是"楷体"这一档会退化成系统字体。

## 要放什么

把 **`LXGWWenKaiLite-Regular.ttf`** 丢进这个目录（文件名必须一模一样），即：

```
ST-Archive/
  fonts/
    LXGWWenKaiLite-Regular.ttf     ← 放这里
```

下载地址（霞鹜文楷 Lite，v1.530）：

- <https://github.com/lxgw/LxgwWenKai-Lite/releases/download/v1.530/LXGWWenKaiLite-Regular.ttf>

约 13.9 MB。放好后**刷新酒馆页面**即可，导出面板里的「楷体」就会用这个字体，
手机、平板、电脑上都一样，不再依赖系统是否装了楷体。

不加这个文件也不会报错：`export.js` 会尝试加载一次，失败就打一行 `console.info`，然后正常回退到系统楷体/宋体。

## 换别的字体行不行

行。只要文件名保持 `LXGWWenKaiLite-Regular.ttf`，随便换成你喜欢的 TTF/OTF 都行
（改了文件名就要同步改 `export.js` 里的 `BUNDLED_KAI_FILE`）。

## 许可

霞鹜文楷（LXGW WenKai）采用 **SIL Open Font License 1.1**：

- 可免费用于个人与商业用途，可再分发
- 分发时需保留 OFL 许可声明；不得单独售卖字体文件本身

完整许可见：<https://github.com/lxgw/LxgwWenKai-Lite/blob/main/OFL.txt>

> 如果你 fork 了这个扩展并准备公开发布，建议把 OFL.txt 一并放进本目录。
