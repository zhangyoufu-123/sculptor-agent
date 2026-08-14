# Stylotrace 公开 API（FastAPI + BYOK）镜像：Node（无头引擎）+ Python（API 服务）
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN pip3 install --no-cache-dir -r api/requirements.txt

ENV PORT=8000
EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
