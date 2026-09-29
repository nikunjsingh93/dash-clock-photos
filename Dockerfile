FROM node:24-alpine
ENV NODE_ENV=production PORT=3080 PHOTO_ROOT=/photos STATE_DIR=/state
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
RUN addgroup -S app && adduser -S -G app -u 10001 app
USER app
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
