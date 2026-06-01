# biliup

## biliup 程序说明

```bash
 biliup -h
Upload video to bilibili.

Usage: biliup [OPTIONS] <COMMAND>

Commands:
  login     登录B站并保存登录信息
  renew     手动验证并刷新登录信息
  upload    上传视频
  append    是否要对某稿件追加视频
  show      打印视频详情
  dump-flv  输出flv元数据
  download  下载视频
  server    启动web服务，默认端口19159
  list      列出所有已上传的视频
  help      Print this message or the help of the given subcommand(s)

Options:
  -p, --proxy <PROXY>              配置代理
  -u, --user-cookie <USER_COOKIE>  登录信息文件 [default: cookies.json]
      --rust-log <RUST_LOG>        [default: tower_http=debug,info]
  -h, --help                       Print help
  -V, --version                    Print version
```

## biliup 上传视频参数说明

```bash
 biliup upload -h
上传视频

Usage: biliup upload [OPTIONS] [VIDEO_PATH]...

Arguments:
  [VIDEO_PATH]...  需要上传的视频路径,若指定配置文件投稿不需要此参数

Options:
      --submit <SUBMIT>              提交接口 [possible values: app, web, b-cut-android]
  -c, --config <FILE>                Sets a custom config file
  -l, --line <LINE>                  选择上传线路 [possible values: bldsa, cnbldsa, andsa, atdsa, bda2, cnbd, anbd, atbd, tx, cntx, antx, attx, bda, txa, alia]
      --limit <LIMIT>                单视频文件最大并发数 [default: 3]
      --copyright <COPYRIGHT>        是否转载, 1-自制 2-转载 [default: 1]
      --source <SOURCE>              转载来源 [default: ]
      --tid <TID>                    投稿分区 [default: 171]
      --cover <COVER>                视频封面 [default: ]
      --title <TITLE>                视频标题 [default: ]
      --desc <DESC>                  视频简介 [default: ]
      --dynamic <DYNAMIC>            空间动态 [default: ]
      --tag <TAG>                    视频标签，逗号分隔多个tag [default: ]
      --dtime <DTIME>                延时发布时间，距离提交大于4小时，格式为10位时间戳
      --interactive <INTERACTIVE>    [default: 0]
      --mission-id <MISSION_ID>
      --dolby <DOLBY>                是否开启杜比音效, 0-关闭 1-开启 [default: 0]
      --hires <LOSSLESS_MUSIC>       是否开启 Hi-Res, 0-关闭 1-开启 [default: 0]
      --no-reprint <NO_REPRINT>      0-允许转载，1-禁止转载 [default: 0]
      --is-only-self <IS_ONLY_SELF>  仅自己可见
      --charging-pay <CHARGING_PAY>  是否开启充电, 0-关闭 1-开启 [default: 0]
      --up-selection-reply           是否开启精选评论，仅提交接口为app时可用
      --up-close-reply               是否关闭评论，仅提交接口为app时可用
      --up-close-danmu               是否关闭弹幕，仅提交接口为app时可用
      --extra-fields <EXTRA_FIELDS>  自定义提交参数
```
