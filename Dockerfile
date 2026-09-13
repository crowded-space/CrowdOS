FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages ./packages
COPY tsconfig.base.json ./tsconfig.base.json

RUN npm ci

EXPOSE 3001

CMD ["npm", "run", "dev", "--workspace", "@crowdspace/server"]
