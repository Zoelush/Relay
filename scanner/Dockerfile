FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends clamav ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY service.mjs /app/service.mjs
EXPOSE 8080
# Before production, pin the tested base image digest and run freshclam on a scheduled maintenance job.
# Missing or stale definitions cause HTTP 503; they never produce a clean verdict.
CMD ["node", "/app/service.mjs"]
