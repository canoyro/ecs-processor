FROM python:3.12-alpine

WORKDIR /app
COPY app.py /app/app.py

RUN mkdir -p /data

EXPOSE 8080
CMD ["python", "/app/app.py"]
