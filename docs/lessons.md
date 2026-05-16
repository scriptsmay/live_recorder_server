# 开发踩坑记录

## 开发进程 nodemon 管理

检查是否还有 nodemon 残留，用这个命令：

```bash
ps aux | grep nodemon | grep -v grep
```

没有输出就是干净的。端口 3001 是否被占用：

```bash
lsof -ti :3001
```
