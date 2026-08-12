# Sculptor Studio Web —— Render 部署镜像
# node（web 零依赖 Node 服务）+ python3 + python-docx（docx 读取/导出/docx_blocks 回填）
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-docx \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
WORKDIR /app/web

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.mjs"]
