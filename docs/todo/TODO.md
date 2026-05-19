# TODO

## docker 镜像中，含有中文的文件名似乎不被biliup能识别，从而导致无法上传

已解决，在 Dockerfile 中添加：
```
# 设置环境变量，强制系统使用 UTF-8
ENV LANG C.UTF-8
ENV LC_ALL C.UTF-8
```

已部署的 docker-compose.yml 中添加环境变量:
```
services:
  your-service-name:
    image: your-image-name
    # 添加以下环境变量配置
    environment:
      - LANG=C.UTF-8
      - LC_ALL=C.UTF-8
    # 其他配置...
    volumes:
      - /path/on/host:/data/video_downloads
```