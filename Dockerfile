FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Jakarta

WORKDIR /app

# 1) install library dulu (supaya build berikutnya cepat)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# 2) salin seluruh project (folder backend + frontend)
COPY . .

# app.py memakai static_folder="../frontend", jadi harus dijalankan dari folder backend
WORKDIR /app/backend

EXPOSE 5000

CMD ["python", "app.py"]
