FROM node:20-alpine AS builder

ENV TZ="Europe/Berlin"

# Create app directory
WORKDIR /app

# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install app dependencies
RUN npm install --silent

COPY . .

RUN npm run build

FROM node:20-alpine

ENV TZ="Europe/Berlin"

RUN apk add --no-cache ffmpeg

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY .env ./

CMD [ "npm", "run", "start:autopilot" ]
