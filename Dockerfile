# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine

ENV PORT=8080

COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

COPY docker-entrypoint.sh /docker-entrypoint.d/40-config-json.sh
RUN chmod +x /docker-entrypoint.d/40-config-json.sh

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
