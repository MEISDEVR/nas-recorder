FROM node:22-alpine
RUN apk add --no-cache ffmpeg openssl tzdata
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/recordings CERT_DIR=/certs HTTP_PORT=8080 HTTPS_PORT=8443 TZ=Asia/Shanghai
EXPOSE 8080 8443
CMD ["node", "server.js"]
