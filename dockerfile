FROM node:18 AS build

WORKDIR /app


COPY package*.json ./


RUN npm install


COPY . .


RUN npm run build


FROM node:18-slim

# Installs latest Chromium (100) package.
RUN apt-get update && apt-get install -y \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      fonts-freefont-ttf

# Tell Puppeteer to skip installing Chrome. We'll be using the installed package.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Install Puppeteer
RUN npm install puppeteer@13.5.0

WORKDIR /app


COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./


RUN npm install --only=production


EXPOSE 3000


CMD ["node", "./dist/index.js"]
