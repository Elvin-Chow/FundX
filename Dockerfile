FROM node:20-slim AS frontend

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN node scripts/db.mjs init && node scripts/db.mjs migrate

FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV FUNDX_APP_ENV=production
ENV FUNDX_USER_DATA_MODE=browser-local
ENV FUNDX_DATA_DIR=/app/data
ENV FUNDX_DB_FILE=/app/data/fundx.db.json
ENV FUNDX_BACKUP_DIR=/app/backups
ENV FUNDX_LOG_DIR=/app/logs
ENV FUNDX_RUNTIME_DIR=/app/.fundx-runtime

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY --from=frontend /app/dist ./dist
COPY --from=frontend /app/data ./data

EXPOSE 7860

CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "7860"]
